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

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Deposits collected</s-heading>
                <s-text type="strong">€0.00</s-text>
                <s-text color="subdued">No orders yet</s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Deposit units sold</s-heading>
                <s-text type="strong">0</s-text>
                <s-text color="subdued">No orders yet</s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Deposits refunded</s-heading>
                <s-text type="strong">€0.00</s-text>
                <s-text color="subdued">No refunds yet</s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Checkouts blocked</s-heading>
                <s-text type="strong">0</s-text>
                <s-text color="subdued">Missing or mismatched deposit</s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
        </s-grid>
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
            <s-table-header-row>
              <s-table-header listSlot="primary">Amount</s-table-header>
              <s-table-header>Applies to</s-table-header>
              <s-table-header>Units</s-table-header>
              <s-table-header>Collected</s-table-header>
              <s-table-header listSlot="secondary">Refunded</s-table-header>
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
                  <s-table-cell>
                    <s-text color="subdued">—</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">—</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">—</s-text>
                  </s-table-cell>
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
