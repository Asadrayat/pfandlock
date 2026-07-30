// "Move this setup to another store" - the migration export. Produces the
// portable half of this app's configuration so it can be rebuilt on the
// client's real (non-Plus) store.
//
// The export deliberately carries no product or variant GIDs. Those are
// per-store, and depending on them is precisely what breaks a migration -
// see getMigrationExport in deposits.server.ts. Products travel as handle +
// variant SKUs so the destination store can match its own catalogue.
//
// The file is built client-side from loader data rather than served from a
// second route: this app renders inside the Shopify admin iframe, where a
// separate authenticated document request for a download is fragile.
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getMigrationExport } from "../deposits.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await getMigrationExport(admin, session.shop);
  return { data };
};

export default function Migration() {
  const { data } = useLoaderData<typeof loader>();

  const download = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pfandlock-config-${data.sourceShop}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const withSku = data.productAssignments.filter(
    (product) => product.skus.length > 0,
  ).length;
  const withoutSku = data.productAssignments.length - withSku;

  return (
    <s-page heading="Move this setup to another store" inlineSize="small">
      <s-link slot="breadcrumb-actions" href="/app/settings">
        Settings
      </s-link>

      <s-banner tone="info" heading="Variant IDs are different on every store">
        <s-paragraph>
          This export contains your amounts and labels, not the IDs. On the
          new store, the app recreates the deposit variants and relinks them
          for you.
        </s-paragraph>
      </s-banner>

      <s-section heading="What gets exported">
        <s-paragraph color="subdued">
          The app code is portable. Only the store-specific data has to be
          rebuilt.
        </s-paragraph>

        <s-stack direction="block" gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone="success">Included</s-badge>
            <s-text>Deposit amounts and labels</s-text>
            <s-text color="subdued">
              {data.tiers.length}{" "}
              {data.tiers.length === 1 ? "amount" : "amounts"}
            </s-text>
          </s-stack>

          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge tone="success">Included</s-badge>
            <s-text>Product-to-amount assignments</s-text>
            <s-text color="subdued">
              {data.productAssignments.length}{" "}
              {data.productAssignments.length === 1 ? "product" : "products"},
              matched by handle and SKU
            </s-text>
          </s-stack>

          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge>Partial</s-badge>
            <s-text>Enforcement and storefront settings</s-text>
            <s-text color="subdued">
              Enforcement state only — no storefront settings are stored yet
            </s-text>
          </s-stack>

          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-badge>Excluded</s-badge>
            <s-text>Variant IDs</s-text>
            <s-text color="subdued">Rebuilt on the new store</s-text>
          </s-stack>
        </s-stack>

        {data.truncated && (
          <s-banner tone="warning" heading="Export is incomplete">
            <s-paragraph>
              This store has more products than the export scans in one pass,
              so some assignments are missing. Migrate the remainder by hand
              after importing this file.
            </s-paragraph>
          </s-banner>
        )}

        {withoutSku > 0 && (
          <s-banner tone="warning" heading="Some products have no SKU">
            <s-paragraph>
              {withoutSku} of {data.productAssignments.length} products carry
              no SKU on any variant, so they can only be matched by handle. If
              handles differ on the destination store, those deposits need
              reassigning by hand.
            </s-paragraph>
          </s-banner>
        )}

        <s-button
          variant="primary"
          onClick={download}
          {...(data.tiers.length === 0 ? { disabled: true } : {})}
        >
          Download configuration
        </s-button>

        {data.tiers.length === 0 && (
          <s-paragraph color="subdued">
            There&apos;s nothing to export yet — add a deposit amount first.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Checklist for the new store">
        <s-ordered-list>
          <s-list-item>
            Confirm the store&apos;s plan supports the features this app uses
          </s-list-item>
          <s-list-item>Install the app</s-list-item>
          <s-list-item>Import this configuration file</s-list-item>
          <s-list-item>
            Let the app recreate the deposit product and variants
          </s-list-item>
          <s-list-item>
            Match products by SKU and apply deposit amounts
          </s-list-item>
          <s-list-item>Turn on enforcement and run the test cart</s-list-item>
        </s-ordered-list>

        <s-banner
          tone="warning"
          heading="Test on the destination store, not just a development store"
        >
          <s-paragraph>
            Development stores have features enabled that a live store may
            not. Run the test cart on the real store before you hand it over.
          </s-paragraph>
        </s-banner>
      </s-section>
    </s-page>
  );
}
