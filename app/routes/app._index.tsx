// Dashboard ("Overview") - the app's home route. A derived view: everything
// here reads real state (deposit tiers, product pfand metafields, Cart
// Transform activation) via deposits.server.ts. Order-derived numbers
// (collected/refunded/blocked) have no data source yet - Activity tracking
// isn't built - so those render an explicit empty state instead of fake
// figures. See pfand-app-ui.html route "dashboard" for the design this
// follows; the money/units/blocked-checkout metrics there are illustrative
// mock data, not a contract to reproduce before the data exists.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getDashboardSummary } from "../deposits.server";
import { formatAmount } from "../deposits.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const summary = await getDashboardSummary(admin, session.shop);
  return { summary };
};

export default function Dashboard() {
  const { summary } = useLoaderData<typeof loader>();
  const orphanedCount = summary.orphanedProducts.length;
  const hasOrphans = orphanedCount > 0;
  const coveragePercent =
    summary.totalProductCount > 0
      ? Math.round((summary.attachingCount / summary.totalProductCount) * 100)
      : 0;

  return (
    <s-page heading="Pfand deposits">
      <s-button slot="primary-action" href="/app/settings">
        Settings
      </s-button>
      <s-button slot="secondary-actions" href="/app/products">
        Manage products
      </s-button>

      {hasOrphans && (
        <s-banner
          tone="warning"
          heading={`${orphanedCount} product${orphanedCount === 1 ? "" : "s"} have a deposit amount with no matching tier`}
        >
          <s-paragraph>
            These products won&apos;t get a deposit attached, and checkout
            will be blocked for any cart containing them. Add the missing
            amount, or change the products to an existing one.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-link href="/app/tiers">Add the missing amount</s-link>
            <s-link href="/app/products">Review products</s-link>
          </s-stack>
        </s-banner>
      )}

      {/*
        Four tiles used to sit here reading €0.00 / 0 / €0.00 / 0. None of the
        four had a data source: nothing records orders, so those were four
        assertions the app couldn't make. One empty state until order tracking
        lands and can derive them.

        Three of the four are coming back. "Checkouts blocked" is not, and it
        deliberately isn't described as pending: a zero there was never "no
        data yet" but a claim about something Shopify structurally never
        reports back to an app - a validation function's outcome reaches the
        buyer's cart and nowhere else (see getActivitySummary in
        deposits.server.ts). Naming it as coming soon would trade one wrong
        number for a promise that can't be kept, so it points at the Activity
        page, which already words the limitation correctly.

        DE, for X-1 - to be used verbatim, not re-translated: "Auswertungen
        sind noch nicht verfügbar. Pfandbuchungen und Erstattungen erscheinen
        hier, sobald die Auftragsverfolgung aktiviert ist. Blockierte
        Bestellvorgänge können nicht gezählt werden — Shopify meldet
        Ergebnisse der Checkout-Prüfung nicht an Apps zurück."
      */}
      <s-section heading="Overview">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Reporting isn&apos;t available yet. Deposit charges and refunds
              will appear here once order tracking is switched on. Blocked
              checkouts can&apos;t be counted — Shopify doesn&apos;t report
              checkout validation outcomes back to apps.
            </s-paragraph>
            <s-link href="/app/activity">Activity &amp; alerts</s-link>
          </s-stack>
        </s-box>
      </s-section>

      <s-section heading="Deposits collected">
        <s-paragraph color="subdued">
          No deposits collected yet. This fills in once orders come through
          with deposit-bearing products.
        </s-paragraph>
      </s-section>

      <s-section heading="Deposits by amount">
        {summary.tiers.length === 0 ? (
          <s-paragraph>
            No deposit amounts configured yet.{" "}
            <s-link href="/app/tiers">Add one</s-link>.
          </s-paragraph>
        ) : (
          <s-table>
            {/*
              Units / Collected / Refunded used to sit alongside these two and
              were an em dash on every row - three of five columns carrying no
              data. They come back per tier, keyed on variantId, once orders
              are recorded (P2-7).
            */}
            <s-table-header-row>
              <s-table-header listSlot="primary">Amount</s-table-header>
              <s-table-header listSlot="secondary">Applies to</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {summary.tiers.map((tier) => (
                <s-table-row key={tier.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small-100">
                      <s-text type="strong">
                        {formatAmount(tier.amount, tier.currency)}
                      </s-text>
                      {tier.label && (
                        <s-text color="subdued">{tier.label}</s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{tier.productCount} products</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="System status">
        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text>Deposits attaching</s-text>
            {summary.cartTransformActive ? (
              <s-badge tone="success">On</s-badge>
            ) : (
              <s-badge tone="critical">Off</s-badge>
            )}
          </s-stack>
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text>Checkout guard</s-text>
            <s-badge tone="success">Always on</s-badge>
          </s-stack>
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text>Deposit amounts</s-text>
            {hasOrphans ? (
              <s-badge tone="warning">{orphanedCount} missing</s-badge>
            ) : (
              <s-badge tone="success">All linked</s-badge>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Coverage">
        <s-stack direction="inline" gap="small-200" alignItems="baseline">
          <s-text type="strong">{summary.attachingCount}</s-text>
          <s-text color="subdued">
            of {summary.totalProductCount} products carry a deposit
          </s-text>
        </s-stack>
        <s-paragraph color="subdued">{coveragePercent}% coverage</s-paragraph>
        <s-button href="/app/products">
          Review products without a deposit
        </s-button>
      </s-section>

      <s-section slot="aside" heading="Recent activity">
        <s-paragraph color="subdued">
          No activity recorded yet. This will show blocked checkouts and
          configuration changes once they happen.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
