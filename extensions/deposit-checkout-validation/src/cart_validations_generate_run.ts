import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

// Mirrors the shop's active `DepositTier` rows, synced onto the
// `$app:deposit_tiers` shop metafield by `syncDepositTiersMetafield`
// (app/deposits.server.ts) - this Function has no other way to reach
// Postgres.
interface DepositTierConfig {
  amount: number; // minor units (cents)
  currency: string;
  variantId: string;
}

export function cartValidationsGenerateRun(
  input: CartValidationsGenerateRunInput,
): CartValidationsGenerateRunResult {
  const tiers = (input.shop.depositTiers?.jsonValue ?? []) as DepositTierConfig[];

  const errors: ValidationError[] = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    // A money metafield's jsonValue looks like {"amount":"0.08","currency_code":"EUR"}.
    const pfand = line.merchandise.product.pfand?.jsonValue as
      | { amount: string; currency_code: string }
      | undefined;
    if (!pfand) continue; // no deposit configured for this product

    const amount = Math.round(parseFloat(pfand.amount) * 100);
    const currency = pfand.currency_code;

    const hasMatchingTier = tiers.some((t) => t.amount === amount && t.currency === currency);
    if (hasMatchingTier) continue;

    // Orphaned: the metafield's amount doesn't match any active tier, so the
    // Cart Transform function has no variant it can charge for this deposit.
    errors.push({
      message: `${line.merchandise.product.title}'s deposit amount is no longer configured - contact the store before checking out.`,
      target: "$.cart",
    });
  }

  return {
    operations: [
      {
        validationAdd: {
          errors,
        },
      },
    ],
  };
}
