import type {
  CartTransformRunInput,
  CartTransformRunResult,
  ExpandedItemPriceAdjustment,
  Operation,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

/**
 * Wraps a price in the shape `ExpandedItem.price` takes.
 *
 * The parameter is typed `string` deliberately. The API's `Decimal` scalar is
 * documented as "serialized as a string" ("29.99"), but codegen maps it to
 * `any` - so nothing stops a number being passed straight through to
 * Shopify. Narrowing it here is the only compile-time guard this file has
 * over the money format.
 */
function fixedPricePerUnit(amount: string): ExpandedItemPriceAdjustment {
  return { adjustment: { fixedPricePerUnit: { amount } } };
}

/** 8 -> "0.08". Tier config is minor units; the price field takes major. */
function minorUnitsToDecimal(minor: number): string {
  return (minor / 100).toFixed(2);
}

// Mirrors the shop's active `DepositTier` rows, synced onto the
// `$app:deposit_tiers` shop metafield by `syncDepositTiersMetafield`
// (app/deposits.server.ts) - this Function has no other way to reach
// Postgres.
interface DepositTierConfig {
  amount: number; // minor units (cents)
  currency: string;
  variantId: string;
}

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const tiers = (input.shop.depositTiers?.jsonValue ?? []) as DepositTierConfig[];
  if (tiers.length === 0) return NO_CHANGES;

  const operations: Operation[] = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    // A money metafield's jsonValue looks like {"amount":"0.08","currency_code":"EUR"}.
    const pfand = line.merchandise.product.pfand?.jsonValue as
      | { amount: string; currency_code: string }
      | undefined;
    if (!pfand) continue; // no deposit configured for this product

    const amount = Math.round(parseFloat(pfand.amount) * 100);
    const currency = pfand.currency_code;

    const tier = tiers.find((t) => t.amount === amount && t.currency === currency);
    // No matching tier = orphaned. The Checkout Validation function blocks
    // checkout for this case; silently skipping here just means no deposit
    // line gets added (nothing to charge without a known variant).
    if (!tier) continue;

    // Both components have to be priced or Shopify falls back to
    // distribution, so a parent price we can't read means we must not expand
    // at all. Skipping leaves the product without its deposit, which the
    // Checkout Validation function catches as an orphan and blocks with a
    // message the shopper can act on - strictly better than expanding into a
    // silently wrong total. The schema types amountPerQuantity as non-null,
    // so this is a guard against the impossible, not an expected branch.
    const parentUnitPrice = line.cost?.amountPerQuantity?.amount;
    if (typeof parentUnitPrice !== "string" || parentUnitPrice.length === 0) {
      continue;
    }

    // expandedCartItems replaces the line entirely (it becomes the bundle's
    // full component list), so the product itself must be listed alongside
    // the deposit - omitting it would drop the product from the cart. Each
    // entry's quantity is per parent unit; Shopify multiplies it by the
    // line's own quantity, so quantity:1 here is what gives the 1:1 scaling
    // (matches Shopify's own gift-wrap/assembly-service expand examples).
    //
    // Both components MUST carry an explicit price. Without one, Shopify
    // *distributes* the parent line's existing price across the components
    // rather than adding the deposit on top: a EUR 699.95 product plus a
    // EUR 0.08 deposit came to EUR 699.95, with the Pfand line rendering
    // 0,08 EUR while carving that 8 cents out of the product. The deposit
    // was shown and never charged. Confirmed across four live checkouts.
    //
    // `fixedPricePerUnit` sets the per-unit price outright despite the
    // surrounding types being named "adjustment" - it is not a delta. Stating
    // the parent's own price is what keeps it whole while the deposit adds to
    // it.
    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: line.merchandise.id,
            quantity: 1,
            // Already a major-unit decimal string ("699.95") in presentment
            // currency, which is exactly what the field takes - passed
            // through rather than parsed, so no rounding is introduced on a
            // value we aren't changing.
            price: fixedPricePerUnit(parentUnitPrice),
          },
          {
            merchandiseId: tier.variantId,
            quantity: 1,
            // The tier is minor units (8), so this one has to be converted:
            // 8 -> "0.08". Different treatment from the line above, on
            // purpose - the two values arrive in different denominations.
            price: fixedPricePerUnit(minorUnitsToDecimal(tier.amount)),
          },
        ],
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
