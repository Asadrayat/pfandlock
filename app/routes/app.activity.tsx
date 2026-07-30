// Activity & alerts - blocked checkouts, configuration changes, and system
// events. The only real signal today is DepositTier create/update
// timestamps (see getActivitySummary in deposits.server.ts). Blocked-
// checkout and error tracking have no data source yet - see that
// function's comment for why blocked checkouts specifically can't be
// observed via any current Shopify API, not just "not built yet".
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getActivitySummary } from "../deposits.server";
import { formatRelativeTime } from "../deposits.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const summary = await getActivitySummary(session.shop);

  return {
    configChangeCount: summary.configChangeCount,
    events: summary.events.map((event) => ({
      id: event.id,
      message: event.message,
      detail: event.detail,
      whenLabel: formatRelativeTime(event.when),
    })),
  };
};

export default function Activity() {
  const { events, configChangeCount } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Activity & alerts">
      <s-button slot="primary-action" href="/app/settings">
        Alert settings
      </s-button>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="1fr 1fr 1fr 1fr" gap="base">
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Blocked checkouts</s-heading>
                <s-text type="strong">—</s-text>
                <s-text color="subdued">
                  Shopify doesn&apos;t expose blocked-checkout events to apps
                </s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Recovered after block</s-heading>
                <s-text type="strong">—</s-text>
                <s-text color="subdued">
                  Depends on blocked-checkout tracking
                </s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Config changes</s-heading>
                <s-text type="strong">{configChangeCount}</s-text>
                <s-text color="subdued">
                  Deposit amounts added or changed
                </s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
          <s-grid-item>
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>Errors</s-heading>
                <s-text type="strong">0</s-text>
                <s-text color="subdued">No errors logged yet</s-text>
              </s-stack>
            </s-box>
          </s-grid-item>
        </s-grid>
      </s-section>

      <s-section heading="Events">
        {events.length === 0 ? (
          <s-paragraph color="subdued">
            No activity yet. Adding or changing a deposit amount will show up
            here.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Event</s-table-header>
              <s-table-header>Detail</s-table-header>
              <s-table-header listSlot="secondary">When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {events.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{event.message}</s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{event.detail ?? "—"}</s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <s-text color="subdued">{event.whenLabel}</s-text>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Not tracked yet">
        <s-paragraph color="subdued">
          Blocked checkouts and runtime errors aren&apos;t recorded anywhere
          yet. Blocked checkouts specifically can&apos;t be read back from
          Shopify today - a validation error is only ever shown to the
          buyer, not reported to the app.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
