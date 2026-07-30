// "Set up Pfand deposits" - the onboarding status view. Purely a reflection
// of state the rest of the app creates: every step's done/not-done comes
// from getOnboardingStatus (deposits.server.ts), never from a stored
// "onboarding completed" flag. A merchant who deletes the deposit product
// or every tier should see those steps go back to "to do".
//
// Note step 1 completes as a side effect of step 3: createDepositTier
// creates the hidden deposit product on first use, so "add your first
// amount" is what actually satisfies both.
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getOnboardingStatus } from "../deposits.server";
import { formatAmount } from "../deposits.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const status = await getOnboardingStatus(admin, session.shop);
  return { status };
};

export default function Onboarding() {
  const { status } = useLoaderData<typeof loader>();
  const hasTiers = status.tiers.length > 0;

  return (
    <s-page heading="Set up Pfand deposits">
      <s-badge
        slot="accessory"
        tone={status.completedSteps === status.totalSteps ? "success" : "info"}
      >
        {status.completedSteps} of {status.totalSteps} done
      </s-badge>

      <s-banner
        tone="info"
        heading="Deposits stay attached, even to a tampered cart"
      >
        <s-paragraph>
          Shopify splits each deposit product into two parts on its own
          servers, so the deposit isn&apos;t a line a buyer can delete. A
          second check blocks checkout — including Shop Pay and Google Pay —
          if a deposit is ever missing.
        </s-paragraph>
      </s-banner>

      <s-section heading="Setup guide">
        <s-stack direction="block" gap="large-100">
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text type="strong">1. Create the deposit product</s-text>
              {status.depositProduct ? (
                <s-badge tone="success">Done</s-badge>
              ) : (
                <s-badge>To do</s-badge>
              )}
            </s-stack>
            <s-text color="subdued">
              One hidden product, one variant per deposit amount. Each variant
              carries its own price.
            </s-text>
            {status.depositProduct ? (
              <s-text color="subdued">
                {status.depositProduct.title} ·{" "}
                {status.depositProduct.variantCount}{" "}
                {status.depositProduct.variantCount === 1
                  ? "variant"
                  : "variants"}
              </s-text>
            ) : (
              <s-button href="/app/tiers">Add your first amount</s-button>
            )}
          </s-stack>

          <s-divider></s-divider>

          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text type="strong">
                2. Add the deposit field to products
              </s-text>
              {status.pfandFieldDefined ? (
                <s-badge tone="success">Done</s-badge>
              ) : (
                <s-badge tone="critical">Missing</s-badge>
              )}
            </s-stack>
            <s-text color="subdued">
              Adds a deposit amount money field to every product, so you can
              set a deposit per product.
            </s-text>
            {!status.pfandFieldDefined && (
              <s-text color="subdued">
                This field ships with the app. If it&apos;s missing, redeploy
                the app to restore it.
              </s-text>
            )}
          </s-stack>

          <s-divider></s-divider>

          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text type="strong">3. Set your deposit amounts</s-text>
              {hasTiers ? (
                <s-badge tone="success">Done</s-badge>
              ) : (
                <s-badge>To do</s-badge>
              )}
            </s-stack>
            <s-text color="subdued">
              Germany&apos;s standard tiers are €0.08, €0.15 and €0.25. Each
              one maps to a priced variant.
            </s-text>
            {hasTiers && (
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Amount</s-table-header>
                  <s-table-header>Label</s-table-header>
                  <s-table-header listSlot="secondary">Status</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {status.tiers.map((tier) => (
                    <s-table-row key={tier.id}>
                      <s-table-cell>
                        <s-text type="strong">
                          {formatAmount(tier.amount, tier.currency)}
                        </s-text>
                      </s-table-cell>
                      <s-table-cell>{tier.label ?? "—"}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone="success">Linked</s-badge>
                      </s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            )}
            <s-button href="/app/tiers">
              {hasTiers ? "Add another amount" : "Set deposit amounts"}
            </s-button>
          </s-stack>

          <s-divider></s-divider>

          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text type="strong">4. Turn on deposit enforcement</s-text>
              {status.cartTransformActive ? (
                <s-badge tone="success">On</s-badge>
              ) : (
                <s-badge>Off</s-badge>
              )}
            </s-stack>
            <s-text color="subdued">
              Activates the server-side rules that attach deposits and block
              checkout when one is missing.
            </s-text>
            {!status.cartTransformActive && (
              <s-button
                variant="primary"
                href="/app/settings"
                {...(hasTiers ? {} : { disabled: true })}
              >
                Turn on enforcement
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Test before you go live">
        <s-paragraph>
          Verify each of these on your storefront before switching the store
          live.
        </s-paragraph>
        <s-button href={status.shop.storefrontUrl} target="_blank">
          Open storefront
        </s-button>
        <s-unordered-list>
          <s-list-item>
            Deposit attaches to a deposit-bearing product
          </s-list-item>
          <s-list-item>Deposit scales 1:1 with quantity</s-list-item>
          <s-list-item>Checkout blocked when deposit is removed</s-list-item>
          <s-list-item>
            Express checkout blocked when deposit is removed
          </s-list-item>
        </s-unordered-list>
        <s-paragraph color="subdued">
          Automated testing isn&apos;t available yet — run these by hand.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Store plan">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <s-text>{status.shop.plan}</s-text>
          <s-badge tone="success">Supported</s-badge>
        </s-stack>
        <s-paragraph color="subdued">
          Everything this app uses runs on every Shopify plan. No Plus
          features required.
        </s-paragraph>
        {status.shop.isDevelopment && (
          <s-paragraph color="subdued">
            This is a development store, where some Plus-only features are
            enabled that a live store won&apos;t have. Re-run the checks above
            on the destination store before handing over.
          </s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="What buyers will see">
        <s-paragraph color="subdued">
          The deposit is part of the product&apos;s line, not a separate line
          the buyer can delete.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
