// "Deposit amounts" admin page. Lists the shop's configured deposit tiers
// and lets a merchant add a new one. See app/deposits.server.ts for what
// actually happens on the Shopify side when a tier is created (a priced
// variant gets added to the shop's hidden "Pfand (Deposit)" product).
import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  createDepositTier,
  detectSupportedCurrencies,
  formatAmount,
  listAllDepositTiers,
  readSupportedCurrencies,
  setDepositTierActive,
} from "../deposits.server";

/**
 * `s-money-field` types `currencyCode` as Shopify's own CurrencyCode union,
 * which @shopify/polaris-types doesn't export on its own. Detected codes come
 * from that same enum on Shopify's side, so reaching into the element's props
 * for the union is how a detected string gets to be one without an `any`.
 */
type MoneyFieldCurrency = NonNullable<
  React.JSX.IntrinsicElements["s-money-field"]["currencyCode"]
>;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Re-detected on every load rather than read from the DB: a merchant can add
  // a market long after installing, and the dropdown is the only thing
  // standing between them and a tier no product can ever match.
  let currencies: string[];
  let currencyError: string | null = null;
  try {
    currencies = await detectSupportedCurrencies(admin, session.shop);
  } catch (error) {
    // A failed lookup shouldn't take the page down - fall back to whatever was
    // detected last time. If that's empty too, the form says so instead of
    // offering a currency we can't stand behind.
    console.error(`Could not detect currencies for ${session.shop}:`, error);
    currencies = await readSupportedCurrencies(session.shop);
    // Carried to the page only when there's nothing to fall back on. Without
    // it the merchant gets a dead end telling them to reload, which is the
    // one thing that can't help when the cause is a bad deploy or a stale
    // server process.
    if (currencies.length === 0) {
      currencyError =
        error instanceof Error ? error.message : "Unknown error from Shopify.";
    }
  }

  // Deactivated tiers included - this is the page a merchant manages them
  // from, so hiding them would leave no way to turn one back on.
  const tiers = await listAllDepositTiers(session.shop);

  // Pre-format the amount here so the component doesn't need to know
  // anything about currency/Intl formatting.
  return {
    currencies,
    currencyError,
    tiers: tiers.map((tier) => ({
      id: tier.id,
      display: formatAmount(tier.amount, tier.currency),
      currency: tier.currency,
      label: tier.label,
      variantId: tier.variantId,
      chargeTax: tier.chargeTax,
      active: tier.active,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  // One action, three jobs - the page posts an intent so the tier list's
  // buttons don't need a route of their own.
  const intent = String(formData.get("intent") || "create");

  if (intent === "deactivate" || intent === "activate") {
    const tierId = String(formData.get("tierId") || "");
    if (!tierId) {
      return { error: "Which deposit amount? None was given." };
    }

    try {
      await setDepositTierActive(
        admin,
        session.shop,
        tierId,
        intent === "activate",
      );
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update deposit amount.",
      };
    }

    return { ok: true };
  }

  const amountEuros = parseFloat(String(formData.get("amount")));
  if (!Number.isFinite(amountEuros) || amountEuros <= 0) {
    return { error: "Enter a valid amount greater than zero." };
  }

  const currency = String(formData.get("currency") || "").trim();
  if (!currency) {
    return { error: "Choose a currency for this deposit amount." };
  }

  const label = String(formData.get("label") || "").trim() || undefined;
  const chargeTax = formData.get("chargeTax") === "true";

  try {
    await createDepositTier(admin, session.shop, {
      // The merchant types major units; we store minor ones (see
      // deposits.server.ts for why - avoids float rounding on money).
      amount: Math.round(amountEuros * 100),
      // Checked against the shop's real currencies server-side too, so a
      // request that skips the dropdown can't get through.
      currency,
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
  const { tiers, currencies, currencyError } = useLoaderData<typeof loader>();
  // Two fetchers so a row's button doesn't put the "add amount" form into a
  // loading state, and so neither one's error banner shows up under the other.
  const fetcher = useFetcher<typeof action>();
  const toggleFetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state === "submitting";
  // Which row is mid-flight, so only that button shows a spinner.
  const togglingTierId = toggleFetcher.formData?.get("tierId");

  // Drives the money field's symbol, so the field a merchant types into shows
  // the currency they actually picked.
  const [currency, setCurrency] = useState(currencies[0] ?? "");
  const currencySelect = useRef<React.ElementRef<"s-select">>(null);

  useEffect(() => {
    const select = currencySelect.current;
    if (!select) return;

    // Polaris web components emit ordinary DOM events. React 18 doesn't bind
    // handler props on custom elements, so the listener is attached directly.
    const onChange = (event: Event) => {
      setCurrency((event.target as HTMLSelectElement).value);
    };
    select.addEventListener("change", onChange);
    return () => select.removeEventListener("change", onChange);
  }, []);

  const canAddTier = currencies.length > 0;

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
              <s-table-header>Currency</s-table-header>
              <s-table-header>Label</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Backing variant</s-table-header>
              <s-table-header listSlot="secondary">Tax</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {tiers.map((tier) => (
                <s-table-row key={tier.id}>
                  <s-table-cell>
                    {tier.active ? (
                      tier.display
                    ) : (
                      <s-text color="subdued">{tier.display}</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>{tier.currency}</s-table-cell>
                  <s-table-cell>{tier.label ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {tier.active ? (
                      <s-badge tone="success">Active</s-badge>
                    ) : (
                      <s-badge>Inactive</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{tier.variantId}</s-text>
                  </s-table-cell>
                  <s-table-cell>{tier.chargeTax ? "Taxed" : "—"}</s-table-cell>
                  <s-table-cell>
                    <toggleFetcher.Form method="post">
                      <input type="hidden" name="tierId" value={tier.id} />
                      <input
                        type="hidden"
                        name="intent"
                        value={tier.active ? "deactivate" : "activate"}
                      />
                      <s-button
                        type="submit"
                        variant="tertiary"
                        {...(togglingTierId === tier.id ? { loading: true } : {})}
                      >
                        {tier.active ? "Deactivate" : "Reactivate"}
                      </s-button>
                    </toggleFetcher.Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}

        {tiers.some((tier) => !tier.active) && (
          <s-paragraph>
            <s-text color="subdued">
              Inactive amounts can&apos;t be assigned to products, and buyers
              are no longer charged them. Any product still carrying one is
              blocked at checkout until you reactivate the amount or assign the
              product a different one.
            </s-text>
          </s-paragraph>
        )}

        {toggleFetcher.data?.error && (
          <s-banner tone="critical">{toggleFetcher.data.error}</s-banner>
        )}
      </s-section>

      <s-section heading="Add deposit amount">
        <s-paragraph>
          Creates a new priced variant on your hidden Pfand product. That
          variant&apos;s price is what buyers are charged, so it always
          matches the amount below automatically.
        </s-paragraph>

        {!canAddTier && (
          <s-banner tone="critical" heading="Couldn't read your store's currencies">
            <s-paragraph>
              Pfandlock asks Shopify which currencies your store sells in before
              it can add a deposit amount, and that lookup failed. Deposit
              amounts already configured are unaffected.
            </s-paragraph>
            {currencyError && (
              <s-paragraph>
                <s-text color="subdued">Shopify said: {currencyError}</s-text>
              </s-paragraph>
            )}
          </s-banner>
        )}

        {canAddTier && (
          <fetcher.Form method="post">
            <s-stack direction="block" gap="base">
              <s-select
                ref={currencySelect}
                name="currency"
                label="Currency"
                value={currency}
                required
                details="Only the currencies your store sells in. A deposit in any other currency could never be charged."
              >
                {currencies.map((code) => (
                  <s-option key={code} value={code}>
                    {code}
                  </s-option>
                ))}
              </s-select>
              <s-money-field
                name="amount"
                label="Amount"
                currencyCode={currency as MoneyFieldCurrency}
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
        )}
      </s-section>
    </s-page>
  );
}
