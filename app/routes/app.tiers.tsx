// "Deposit amounts" admin page. Lists the shop's configured deposit tiers
// and lets a merchant add a new one. See app/deposits.server.ts for what
// actually happens on the Shopify side when a tier is created (a priced
// variant gets added to the shop's hidden "Pfand (Deposit)" product).
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  createDepositTier,
  formatAmount,
  listDepositTiers,
} from "../deposits.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const tiers = await listDepositTiers(session.shop);

  // Pre-format the amount here so the component doesn't need to know
  // anything about currency/Intl formatting.
  return {
    tiers: tiers.map((tier) => ({
      id: tier.id,
      display: formatAmount(tier.amount, tier.currency),
      label: tier.label,
      variantId: tier.variantId,
      chargeTax: tier.chargeTax,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const amountEuros = parseFloat(String(formData.get("amount")));
  if (!Number.isFinite(amountEuros) || amountEuros <= 0) {
    return { error: "Enter a valid amount greater than zero." };
  }

  const label = String(formData.get("label") || "").trim() || undefined;
  const chargeTax = formData.get("chargeTax") === "true";

  try {
    await createDepositTier(admin, session.shop, {
      // The merchant types euros; we store cents (see deposits.server.ts
      // for why - avoids float rounding on money).
      amount: Math.round(amountEuros * 100),
      label,
      chargeTax,
    });
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Failed to create deposit amount.",
    };
  }

  return { ok: true };
};

export default function Tiers() {
  const { tiers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state === "submitting";

  return (
    <s-page heading="Deposit amounts">
      <s-section heading="Configured amounts">
        {tiers.length === 0 ? (
          <s-paragraph>
            No deposit amounts yet. Add one below to start assigning deposits
            to products.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Amount</s-table-header>
              <s-table-header>Label</s-table-header>
              <s-table-header>Backing variant</s-table-header>
              <s-table-header listSlot="secondary">Tax</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {tiers.map((tier) => (
                <s-table-row key={tier.id}>
                  <s-table-cell>{tier.display}</s-table-cell>
                  <s-table-cell>{tier.label ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{tier.variantId}</s-text>
                  </s-table-cell>
                  <s-table-cell>{tier.chargeTax ? "Taxed" : "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Add deposit amount">
        <s-paragraph>
          Creates a new priced variant on your hidden Pfand product. That
          variant&apos;s price is what buyers are charged, so it always
          matches the amount below automatically.
        </s-paragraph>

        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-money-field
              name="amount"
              label="Amount"
              currencyCode="EUR"
              required
              details="The refundable amount charged per unit."
            />
            <s-text-field
              name="label"
              label="Label"
              placeholder="e.g. Crate"
              details="Shown to you in this app, and to buyers on the storefront."
            />
            <s-checkbox
              name="chargeTax"
              value="true"
              label="Charge tax on this deposit"
              details="Check with your accountant. In Germany, deposit tax treatment depends on the container type."
            />

            {fetcher.data?.error && (
              <s-banner tone="critical">{fetcher.data.error}</s-banner>
            )}

            <s-button
              variant="primary"
              type="submit"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Add amount
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}
