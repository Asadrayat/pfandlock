// Unit tests for the Checkout Validation's blocking rules.
//
// The companion default.test.js runs fixtures through the compiled wasm and
// is the real integration check; it needs the Shopify CLI on PATH to locate
// the function runner. These cover the decision logic directly, against the
// same source the wasm is built from.
//
// This function is the last thing standing between a tampered cart and a
// completed order - it's what catches a deposit stripped via the Ajax Cart
// API, including through Shop Pay and Google Pay - so the emphasis is on
// which carts it refuses rather than which it lets through.
import { describe, expect, it } from "vitest";
import type { CartValidationsGenerateRunInput } from "../generated/api";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

type Line = CartValidationsGenerateRunInput["cart"]["lines"][number];

const DEPOSIT_VARIANT = "gid://shopify/ProductVariant/deposit-8";

const EIGHT_CENT_TIER = {
  amount: 8,
  currency: "EUR",
  variantId: DEPOSIT_VARIANT,
};

/** A normal product line, optionally carrying a deposit metafield. */
const productLine = (options: {
  quantity?: number;
  variantId?: string;
  title?: string;
  pfand?: { amount: string; currency_code: string } | null;
}): Line => ({
  __typename: "CartLine",
  quantity: options.quantity ?? 1,
  merchandise: {
    __typename: "ProductVariant",
    id: options.variantId ?? "gid://shopify/ProductVariant/1",
    product: {
      __typename: "Product",
      title: options.title ?? "Sparkling Water",
      pfand: options.pfand
        ? { __typename: "Metafield", jsonValue: options.pfand }
        : null,
    },
  },
});

/** The deposit component line the Cart Transform expands into the cart. */
const depositLine = (quantity = 1, variantId = DEPOSIT_VARIANT): Line => ({
  __typename: "CartLine",
  quantity,
  merchandise: {
    __typename: "ProductVariant",
    id: variantId,
    product: { __typename: "Product", title: "Pfand (Deposit)", pfand: null },
  },
});

const customLine = (): Line => ({
  __typename: "CartLine",
  quantity: 1,
  merchandise: { __typename: "CustomProduct" },
});

const input = (
  lines: Line[],
  tiers: Array<{ amount: number; currency: string; variantId: string }> | null,
): CartValidationsGenerateRunInput => ({
  __typename: "Input",
  cart: { __typename: "Cart", lines },
  shop: {
    __typename: "Shop",
    depositTiers: tiers === null ? null : { __typename: "Metafield", jsonValue: tiers },
  },
});

/** The errors from the single validationAdd operation the function returns. */
const errorsFrom = (result: ReturnType<typeof cartValidationsGenerateRun>) =>
  result.operations[0].validationAdd!.errors;

const EIGHT_CENT_PFAND = { amount: "0.08", currency_code: "EUR" };

describe("cartValidationsGenerateRun", () => {
  it("allows a cart whose deposit is present and correct", () => {
    const result = cartValidationsGenerateRun(
      input([productLine({ pfand: EIGHT_CENT_PFAND }), depositLine()], [EIGHT_CENT_TIER]),
    );

    expect(errorsFrom(result)).toEqual([]);
  });

  it("always returns one validationAdd operation, even with nothing wrong", () => {
    // The shape is the contract: an empty errors list is how this function
    // says "allowed", not an empty operations list.
    const result = cartValidationsGenerateRun(input([], [EIGHT_CENT_TIER]));

    expect(result.operations).toHaveLength(1);
    expect(errorsFrom(result)).toEqual([]);
  });

  it("blocks a cart whose deposit line was removed", () => {
    // The Ajax Cart API can strip the expanded component. This is the case
    // the whole function exists for.
    const result = cartValidationsGenerateRun(
      input([productLine({ pfand: EIGHT_CENT_PFAND })], [EIGHT_CENT_TIER]),
    );

    expect(errorsFrom(result)).toEqual([
      {
        message:
          "The refundable deposit (Pfand) for your items is missing or incorrect. Refresh your cart to continue.",
        target: "$.cart",
      },
    ]);
  });

  it("counts deposits per unit, not per line", () => {
    // Three bottles need three deposits. Two would let one through free.
    const result = cartValidationsGenerateRun(
      input(
        [productLine({ quantity: 3, pfand: EIGHT_CENT_PFAND }), depositLine(2)],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toHaveLength(1);
    expect(errorsFrom(result)[0].message).toContain("missing or incorrect");
  });

  it("allows a quantity that lines up exactly", () => {
    const result = cartValidationsGenerateRun(
      input(
        [productLine({ quantity: 3, pfand: EIGHT_CENT_PFAND }), depositLine(3)],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toEqual([]);
  });

  it("totals requirements and deposits across the whole cart", () => {
    const result = cartValidationsGenerateRun(
      input(
        [
          productLine({ quantity: 2, pfand: EIGHT_CENT_PFAND }),
          productLine({
            quantity: 3,
            variantId: "gid://shopify/ProductVariant/2",
            pfand: EIGHT_CENT_PFAND,
          }),
          depositLine(5),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toEqual([]);
  });

  it("blocks a cart carrying more deposits than it owes", () => {
    // The comparison is an equality, not a floor - a cart with extra deposit
    // lines is as desynced as one missing them, and would overcharge.
    const result = cartValidationsGenerateRun(
      input(
        [productLine({ pfand: EIGHT_CENT_PFAND }), depositLine(4)],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toHaveLength(1);
  });

  it("names the product whose amount is no longer configured", () => {
    const result = cartValidationsGenerateRun(
      input(
        [productLine({ title: "Cider Bottle", pfand: { amount: "0.25", currency_code: "EUR" } })],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toEqual([
      {
        message:
          "Cider Bottle's deposit amount is no longer configured - contact the store before checking out.",
        target: "$.cart",
      },
    ]);
  });

  it("reports every misconfigured product, not just the first", () => {
    const result = cartValidationsGenerateRun(
      input(
        [
          productLine({ title: "Cider", pfand: { amount: "0.25", currency_code: "EUR" } }),
          productLine({
            title: "Beer",
            variantId: "gid://shopify/ProductVariant/2",
            pfand: { amount: "0.30", currency_code: "EUR" },
          }),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result).map((error) => error.message)).toEqual([
      "Cider's deposit amount is no longer configured - contact the store before checking out.",
      "Beer's deposit amount is no longer configured - contact the store before checking out.",
    ]);
  });

  it("doesn't pile the generic message on top of a specific one", () => {
    // An orphaned product also has no deposit line, so both rules would fire.
    // The named message is the actionable one; adding "refresh your cart"
    // underneath just tells the buyer to retry something that can't work.
    const result = cartValidationsGenerateRun(
      input(
        [productLine({ title: "Cider", pfand: { amount: "0.25", currency_code: "EUR" } })],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toHaveLength(1);
    expect(errorsFrom(result)[0].message).not.toContain("Refresh your cart");
  });

  it("treats a currency mismatch as unconfigured", () => {
    const result = cartValidationsGenerateRun(
      input(
        [productLine({ title: "Import", pfand: { amount: "0.08", currency_code: "USD" } })],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)[0].message).toContain("Import's deposit amount");
  });

  it("allows a cart of products that carry no deposit", () => {
    const result = cartValidationsGenerateRun(
      input([productLine({ quantity: 4 }), customLine()], [EIGHT_CENT_TIER]),
    );

    expect(errorsFrom(result)).toEqual([]);
  });

  it("blocks every deposited product when the shop has no tiers at all", () => {
    // With the config gone there's nothing to match against, so each one is
    // orphaned rather than silently allowed through.
    const result = cartValidationsGenerateRun(
      input([productLine({ title: "Water", pfand: EIGHT_CENT_PFAND })], null),
    );

    expect(errorsFrom(result)).toHaveLength(1);
    expect(errorsFrom(result)[0].message).toContain("Water's deposit amount");
  });

  it("never counts a deposit line as itself needing a deposit", () => {
    // Deposit lines are identified by variant id and accounted for before
    // the metafield check, so they can't inflate the requirement.
    const result = cartValidationsGenerateRun(
      input([depositLine(3)], [EIGHT_CENT_TIER]),
    );

    // Three deposits and nothing requiring them is still a mismatch, but the
    // point is that it's 3 vs 0, not 3 vs 3 masking the problem.
    expect(errorsFrom(result)).toHaveLength(1);
  });

  it("matches deposit lines by their configured variant id", () => {
    // A variant that isn't one of the shop's deposit variants is an ordinary
    // product, even if it looks like a deposit.
    const result = cartValidationsGenerateRun(
      input(
        [
          productLine({ pfand: EIGHT_CENT_PFAND }),
          depositLine(1, "gid://shopify/ProductVariant/not-a-deposit"),
        ],
        [EIGHT_CENT_TIER],
      ),
    );

    expect(errorsFrom(result)).toHaveLength(1);
    expect(errorsFrom(result)[0].message).toContain("missing or incorrect");
  });

  it("ignores merchandise that isn't a product variant", () => {
    const result = cartValidationsGenerateRun(
      input([customLine()], [EIGHT_CENT_TIER]),
    );

    expect(errorsFrom(result)).toEqual([]);
  });

  it("rounds the metafield's decimal string to minor units", () => {
    // 0.29 * 100 is 28.999999999999996 - truncating would block a checkout
    // that's perfectly well configured.
    const result = cartValidationsGenerateRun(
      input(
        [
          productLine({ pfand: { amount: "0.29", currency_code: "EUR" } }),
          depositLine(1, "gid://shopify/ProductVariant/deposit-29"),
        ],
        [
          {
            amount: 29,
            currency: "EUR",
            variantId: "gid://shopify/ProductVariant/deposit-29",
          },
        ],
      ),
    );

    expect(errorsFrom(result)).toEqual([]);
  });
});
