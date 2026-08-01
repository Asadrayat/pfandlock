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
// separate authenticated document request for a download is fragile. The
// uploaded file is likewise read in the browser and posted as text, which
// avoids multipart handling for what is a small JSON document.
//
// Import is deliberately two-step: preview, then apply. This writes to a
// live client store (creates products/variants, rewrites product
// metafields), so the merchant sees exactly what will change - especially
// which products couldn't be matched - before anything happens.
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  applyMigrationImport,
  getMigrationExport,
  parseMigrationExportFile,
  previewMigrationImport,
} from "../deposits.server";
import { formatAmount } from "../deposits.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await getMigrationExport(admin, session.shop);
  return { data };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));
  const raw = String(formData.get("config") ?? "");

  try {
    const parsed = parseMigrationExportFile(raw);

    if (intent === "preview") {
      const plan = await previewMigrationImport(admin, session.shop, parsed);
      return { plan, result: null, error: null };
    }
    if (intent === "apply") {
      const result = await applyMigrationImport(admin, session.shop, parsed);
      return { plan: null, result, error: null };
    }
    return { plan: null, result: null, error: "Unknown action." };
  } catch (error) {
    return {
      plan: null,
      result: null,
      error:
        error instanceof Error
          ? error.message
          : "Couldn't read that configuration file.",
    };
  }
};

export default function Migration() {
  const { data } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const isBusy = fetcher.state !== "idle";
  const plan = fetcher.data?.plan ?? null;
  const result = fetcher.data?.result ?? null;
  const importError = fetcher.data?.error ?? null;

  const handleFile = async (event: {
    currentTarget: { files?: File[] | FileList | null };
  }) => {
    const selected = event.currentTarget.files;
    const file = selected ? Array.from(selected)[0] : undefined;
    if (!file) return;
    setFileName(file.name);
    setFileText(await file.text());
  };

  const submitImport = (intent: "preview" | "apply") => {
    if (!fileText) return;
    fetcher.submit({ intent, config: fileText }, { method: "post" });
  };

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

      <s-section heading="Import a configuration">
        <s-paragraph>
          Upload a configuration exported from another store. Deposit amounts
          and product assignments are added; nothing already set up here is
          removed.
        </s-paragraph>

        <s-drop-zone
          label="Configuration file"
          accept=".json,application/json"
          onChange={handleFile}
        ></s-drop-zone>

        {fileName && <s-text color="subdued">Selected: {fileName}</s-text>}

        {importError && <s-banner tone="critical">{importError}</s-banner>}

        <s-button
          onClick={() => submitImport("preview")}
          {...(!fileText || isBusy ? { disabled: true } : {})}
        >
          Preview changes
        </s-button>

        {plan && (
          <s-stack direction="block" gap="base">
            <s-heading>What this import will do</s-heading>
            <s-paragraph color="subdued">
              Exported from {plan.sourceShop}
            </s-paragraph>

            <s-stack direction="block" gap="small-300">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-badge tone="success">Create</s-badge>
                <s-text>
                  {plan.tiersToCreate.length} deposit{" "}
                  {plan.tiersToCreate.length === 1 ? "amount" : "amounts"}
                </s-text>
              </s-stack>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-badge>Skip</s-badge>
                <s-text>
                  {plan.tiersAlreadyPresent.length} already configured here
                </s-text>
              </s-stack>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-badge tone="success">Assign</s-badge>
                <s-text>{plan.matched.length} products matched</s-text>
              </s-stack>
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-badge tone="warning">No match</s-badge>
                <s-text>
                  {plan.unmatched.length} products not found here
                </s-text>
              </s-stack>
            </s-stack>

            {plan.missingTier.length > 0 && (
              <s-banner
                tone="critical"
                heading="Some products would have no matching amount"
              >
                <s-paragraph>
                  {plan.missingTier.length} products reference a deposit
                  amount this file doesn&apos;t create. Importing would leave
                  them orphaned, and carts containing them can&apos;t be
                  checked out.
                </s-paragraph>
              </s-banner>
            )}

            {plan.destinationTruncated && (
              <s-banner tone="warning" heading="This store's catalogue is large">
                <s-paragraph>
                  Not every product here was scanned, so some matches may be
                  missed. Check the unmatched list carefully before applying.
                </s-paragraph>
              </s-banner>
            )}

            {plan.unmatched.length > 0 && (
              <s-banner tone="warning" heading="Some products weren't found">
                <s-paragraph>
                  These exist in the file but not in this store, by SKU or
                  handle. Assign their deposits by hand after importing.
                </s-paragraph>
                <s-unordered-list>
                  {plan.unmatched.slice(0, 10).map((product) => (
                    <s-list-item key={product.handle}>
                      {product.title}
                    </s-list-item>
                  ))}
                </s-unordered-list>
                {plan.unmatched.length > 10 && (
                  <s-paragraph color="subdued">
                    and {plan.unmatched.length - 10} more
                  </s-paragraph>
                )}
              </s-banner>
            )}

            {plan.matched.length > 0 && (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Product</s-table-header>
                  <s-table-header>Deposit</s-table-header>
                  <s-table-header>Matched by</s-table-header>
                  <s-table-header listSlot="secondary">Action</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {plan.matched.slice(0, 50).map((product) => (
                    <s-table-row key={product.productId}>
                      <s-table-cell>{product.title}</s-table-cell>
                      <s-table-cell>
                        {formatAmount(product.amount, product.currency)}
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{product.matchedBy}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        {product.alreadyCorrect ? (
                          <s-badge>Already set</s-badge>
                        ) : (
                          <s-badge tone="success">Will assign</s-badge>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}

            {plan.matched.length > 50 && (
              <s-paragraph color="subdued">
                Showing the first 50 of {plan.matched.length} matches. All of
                them are applied.
              </s-paragraph>
            )}

            <s-button
              variant="primary"
              onClick={() => submitImport("apply")}
              {...(isBusy ? { disabled: true } : {})}
            >
              Apply import
            </s-button>
          </s-stack>
        )}

        {result && (
          <s-banner tone="success" heading="Import complete">
            <s-paragraph>
              Created {result.tiersCreated} deposit{" "}
              {result.tiersCreated === 1 ? "amount" : "amounts"} and assigned
              deposits to {result.productsAssigned} products.
              {result.productsSkipped > 0 &&
                ` ${result.productsSkipped} already had the right deposit.`}
              {result.unmatched > 0 &&
                ` ${result.unmatched} products couldn't be matched and still need assigning by hand.`}
            </s-paragraph>
          </s-banner>
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
