import type {
  CartTransformRunInput,
  CartTransformRunResult,
  Operation,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

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

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems: [
          {
            merchandiseId: tier.variantId,
            quantity: line.quantity,
          },
        ],
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
