// Unit tests for the Cart Transform's decision logic.
//
// The companion default.test.js runs fixtures through the compiled wasm and
// is the real integration check. It needs the Shopify CLI on PATH to locate
// the function runner, so these cover the branching directly: which lines
// get a deposit attached, which are left alone, and what the expand payload
// has to contain. Fast enough to run on every save, and they exercise the
// same source the wasm is built from.
import { describe, expect, it } from "vitest";
import type { CartTransformRunInput } from "../generated/api";
import { cartTransformRun } from "../src/cart_transform_run";

type Line = CartTransformRunInput["cart"]["lines"][number];

/**
 * `unitPrice` is the parent's own per-unit price, which the expand has to
 * restate on the product component - without it Shopify distributes the
 * parent's price across the components instead of adding the deposit on top.
 * A major-unit decimal string, as the Decimal scalar is serialized.
 */
const variantLine = (options: {
  id?: string;
  quantity?: number;
  variantId?: string;
  unitPrice?: string;
  pfand?: { amount: string; currency_code: string } | null;
}): Line => ({
  __typename: "CartLine",
  id: options.id ?? "gid://shopify/CartLine/1",
  quantity: options.quantity ?? 1,
  cost: {
    __typename: "CartLineCost",
    amountPerQuantity: {
      __typename: "MoneyV2",
      amount: options.unitPrice ?? "10.00",
      currencyCode: "EUR" as Line["cost"]["amountPerQuantity"]["currencyCode"],
    },
  },
  merchandise: {
    __typename: "ProductVariant",
    id: options.variantId ?? "gid://shopify/ProductVariant/1",
    product: {
      __typename: "Product",
      pfand: options.pfand
        ? { __typename: "Metafield", jsonValue: options.pfand }
        : null,
    },
  },
});

/** A line whose merchandise isn't a variant at all, e.g. a custom item. */
const customLine = (id = "gid://shopify/CartLine/custom"): Line => ({
  __typename: "CartLine",
  id,
  quantity: 1,
  cost: {
    __typename: "CartLineCost",
    amountPerQuantity: {
      __typename: "MoneyV2",
      amount: "10.00",
      currencyCode: "EUR" as Line["cost"]["amountPerQuantity"]["currencyCode"],
    },
  },
  merchandise: { __typename: "CustomProduct" },
});

const input = (
  lines: Line[],
  tiers: Array<{ amount: number; currency: string; variantId: string }> | null,
): CartTransformRunInput => ({
  __typename: "Input",
  cart: { __typename: "Cart", lines },
  shop: {
    __typename: "Shop",
    depositTiers: tiers === null ? null : { __typename: "Metafield", jsonValue: tiers },
  },
});

const EIGHT_CENT_TIER = {
  amount: 8,
  currency: "EUR",
  variantId: "gid://shopify/ProductVariant/deposit-8",
};

describe("cartTransformRun", () => {
  it("expands a line whose deposit matches a configured tier", () => {
    const result = cartTransformRun(
      input(
        [
          variantLine({
            unitPrice: "699.95",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(result).toEqual({
      operations: [
        {
          lineExpand: {
            cartLineId: "gid://shopify/CartLine/1",
            expandedCartItems: [
              {
                merchandiseId: "gid://shopify/ProductVariant/1",
                quantity: 1,
                price: { adjustment: { fixedPricePerUnit: { amount: "699.95" } } },
              },
              {
                merchandiseId: "gid://shopify/ProductVariant/deposit-8",
                quantity: 1,
                price: { adjustment: { fixedPricePerUnit: { amount: "0.08" } } },
              },
            ],
          },
        },
      ],
    });
  });

  it("adds the deposit on top instead of carving it out of the product", () => {
    // The defect this pricing exists for. With no price on the components,
    // Shopify distributes the parent line's price across them: a EUR 699.95
    // product plus a EUR 0.08 deposit totalled EUR 699.95, the Pfand line
    // showing 0,08 EUR while taking those 8 cents out of the product. The
    // deposit was displayed and never charged, on four live checkouts.
    const result = cartTransformRun(
      input(
        [
          variantLine({
            unitPrice: "699.95",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    const items = result.operations[0].lineExpand!.expandedCartItems;
    const total = items.reduce(
      (sum, item) =>
        sum + Math.round(parseFloat(item.price!.adjustment.fixedPricePerUnit!.amount) * 100),
      0,
    );

    expect(total).toBe(70003); // EUR 700.03, not EUR 699.95
  });

  it("prices the deposit component from the tier, in major units", () => {
    // The tier config is minor units (8) and the price field takes a
    // major-unit decimal string, so this is the one component that needs
    // converting. Sending "8" would charge EUR 8.00 of Pfand.
    const result = cartTransformRun(
      input(
        [variantLine({ pfand: { amount: "0.25", currency_code: "EUR" } })],
        [{ amount: 25, currency: "EUR", variantId: "gid://shopify/ProductVariant/deposit-25" }],
      ),
    );

    const deposit = result.operations[0].lineExpand!.expandedCartItems[1];
    expect(deposit.price!.adjustment.fixedPricePerUnit!.amount).toBe("0.25");
  });

  it("passes the parent's price through untouched", () => {
    // Restating the parent's own price is what keeps it whole. Reformatting
    // it - parsing to a float and back - would risk changing a value we have
    // no business changing.
    const result = cartTransformRun(
      input(
        [
          variantLine({
            unitPrice: "1.005",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    const product = result.operations[0].lineExpand!.expandedCartItems[0];
    expect(product.price!.adjustment.fixedPricePerUnit!.amount).toBe("1.005");
  });

  it("does not expand when the parent's unit price is unreadable", () => {
    // Both components have to be priced or Shopify goes back to distributing,
    // so a line with no readable price must not expand at all. The product
    // then has no deposit attached, which the Checkout Validation function
    // catches as an orphan - a blocked checkout with an actionable message,
    // rather than a silently wrong total.
    const line = variantLine({ pfand: { amount: "0.08", currency_code: "EUR" } });
    // No ts-expect-error needed, and that is the point: codegen maps the
    // Decimal scalar to `any`, so assigning null here typechecks cleanly.
    // Nothing in the type system defends this field - only the guard does.
    line.cost.amountPerQuantity.amount = null;

    const result = cartTransformRun(input([line], [EIGHT_CENT_TIER]));

    expect(result.operations).toEqual([]);
  });

  it("keeps the product itself in the expanded list", () => {
    // expandedCartItems replaces the line outright - it becomes the bundle's
    // complete component list. Listing only the deposit would delete the
    // product the buyer actually wanted from their cart.
    const result = cartTransformRun(
      input(
        [
          variantLine({
            variantId: "gid://shopify/ProductVariant/water",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    const items = result.operations[0].lineExpand!.expandedCartItems;
    expect(items[0].merchandiseId).toBe("gid://shopify/ProductVariant/water");
    expect(items).toHaveLength(2);
  });

  it("uses a quantity of 1 per parent unit, not the line's quantity", () => {
    // Shopify multiplies each entry by the line's own quantity, so hardcoding
    // the line quantity here would square it - six deposits on a case of six.
    const result = cartTransformRun(
      input(
        [variantLine({ quantity: 6, pfand: { amount: "0.08", currency_code: "EUR" } })],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(
      result.operations[0].lineExpand!.expandedCartItems.map((item) => item.quantity),
    ).toEqual([1, 1]);
  });

  it("leaves a product with no deposit alone", () => {
    const result = cartTransformRun(
      input([variantLine({ pfand: null })], [EIGHT_CENT_TIER]),
    );

    expect(result.operations).toEqual([]);
  });

  it("skips a deposit amount no tier backs", () => {
    // Nothing to charge without a known variant. The Validation function is
    // what stops this cart from checking out.
    const result = cartTransformRun(
      input(
        [variantLine({ pfand: { amount: "0.25", currency_code: "EUR" } })],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(result.operations).toEqual([]);
  });

  it("skips a matching amount in a different currency", () => {
    const result = cartTransformRun(
      input(
        [variantLine({ pfand: { amount: "0.08", currency_code: "USD" } })],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(result.operations).toEqual([]);
  });

  it("ignores merchandise that isn't a product variant", () => {
    // A custom line has no product and so no metafield to read - reaching
    // for one would throw inside the function rather than skip the line.
    const result = cartTransformRun(input([customLine()], [EIGHT_CENT_TIER]));

    expect(result.operations).toEqual([]);
  });

  it("does nothing when the shop has no tier config at all", () => {
    const result = cartTransformRun(
      input([variantLine({ pfand: { amount: "0.08", currency_code: "EUR" } })], null),
    );

    expect(result.operations).toEqual([]);
  });

  it("does nothing when the tier config is present but empty", () => {
    // What a shop looks like after its last tier is removed.
    const result = cartTransformRun(
      input([variantLine({ pfand: { amount: "0.08", currency_code: "EUR" } })], []),
    );

    expect(result.operations).toEqual([]);
  });

  it("picks the tier matching each line's own amount", () => {
    const result = cartTransformRun(
      input(
        [
          variantLine({
            id: "gid://shopify/CartLine/1",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
          variantLine({
            id: "gid://shopify/CartLine/2",
            variantId: "gid://shopify/ProductVariant/2",
            pfand: { amount: "0.15", currency_code: "EUR" },
          }),
        ],
        [
          EIGHT_CENT_TIER,
          {
            amount: 15,
            currency: "EUR",
            variantId: "gid://shopify/ProductVariant/deposit-15",
          },
        ],
      ),
    );

    expect(
      result.operations.map(
        (operation) => operation.lineExpand!.expandedCartItems[1].merchandiseId,
      ),
    ).toEqual([
      "gid://shopify/ProductVariant/deposit-8",
      "gid://shopify/ProductVariant/deposit-15",
    ]);
  });

  it("handles a mixed cart one line at a time", () => {
    const result = cartTransformRun(
      input(
        [
          variantLine({
            id: "gid://shopify/CartLine/1",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
          variantLine({ id: "gid://shopify/CartLine/2", pfand: null }),
          variantLine({
            id: "gid://shopify/CartLine/3",
            pfand: { amount: "0.25", currency_code: "EUR" },
          }),
          customLine("gid://shopify/CartLine/4"),
          variantLine({
            id: "gid://shopify/CartLine/5",
            pfand: { amount: "0.08", currency_code: "EUR" },
          }),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    // Only the two matching lines are touched, and one skipped line doesn't
    // stop the ones after it being processed.
    expect(result.operations.map((operation) => operation.lineExpand!.cartLineId)).toEqual([
      "gid://shopify/CartLine/1",
      "gid://shopify/CartLine/5",
    ]);
  });

  it("rounds the metafield's decimal string to minor units", () => {
    // 0.29 * 100 is 28.999999999999996; truncating would orphan the line.
    const result = cartTransformRun(
      input(
        [variantLine({ pfand: { amount: "0.29", currency_code: "EUR" } })],
        [
          {
            amount: 29,
            currency: "EUR",
            variantId: "gid://shopify/ProductVariant/deposit-29",
          },
        ],
      ),
    );

    expect(result.operations[0].lineExpand!.expandedCartItems[1].merchandiseId).toBe(
      "gid://shopify/ProductVariant/deposit-29",
    );
  });

  it("returns no operations for an empty cart", () => {
    expect(cartTransformRun(input([], [EIGHT_CENT_TIER])).operations).toEqual([]);
  });
});
