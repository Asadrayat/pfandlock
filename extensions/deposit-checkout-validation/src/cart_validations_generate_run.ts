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
  const depositVariantIds = new Set(tiers.map((t) => t.variantId));

  const errors: ValidationError[] = [];
  let requiredDeposits = 0;
  let actualDeposits = 0;

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    if (depositVariantIds.has(line.merchandise.id)) {
      actualDeposits += line.quantity;
      continue;
    }

    // A money metafield's jsonValue looks like {"amount":"0.08","currency_code":"EUR"}.
    const pfand = line.merchandise.product.pfand?.jsonValue as
      | { amount: string; currency_code: string }
      | undefined;
    if (!pfand) continue; // no deposit configured for this product

    requiredDeposits += line.quantity;

    const amount = Math.round(parseFloat(pfand.amount) * 100);
    const currency = pfand.currency_code;
    const hasMatchingTier = tiers.some((t) => t.amount === amount && t.currency === currency);

    // Orphaned: the metafield's amount doesn't match any active tier, so the
    // Cart Transform function has no variant it can charge for this deposit.
    if (!hasMatchingTier) {
      errors.push({
        message: `${line.merchandise.product.title}'s deposit amount is no longer configured - contact the store before checking out.`,
        target: "$.cart",
      });
    }
  }

  // Backstop for Approach C: even when every product's amount matches a
  // configured tier, the deposit component itself can still be absent from
  // the cart (Cart Transform hasn't run yet, a bug, or a tampered Ajax Cart
  // API request that strips or desyncs the expanded line). A per-unit
  // mismatch here means the cart doesn't actually carry the deposits it
  // owes, regardless of whether every tier is individually well-configured.
  if (errors.length === 0 && actualDeposits !== requiredDeposits) {
    errors.push({
      message:
        "The refundable deposit (Pfand) for your items is missing or incorrect. Refresh your cart to continue.",
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
