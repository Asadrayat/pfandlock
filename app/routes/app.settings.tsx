// "Settings" admin page. Phase 2: lets a merchant turn on checkout
// enforcement - registering the `deposit-cart-transform` Cart Transform
// function for this shop, which is what actually adds the deposit as a cart
// line (see extensions/deposit-cart-transform). The companion
// `deposit-checkout-validation` function (which blocks checkout for
// orphaned/misconfigured deposit amounts) activates automatically once
// deployed - it doesn't need a per-shop enable step.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

const CART_TRANSFORM_FUNCTION_HANDLE = "deposit-cart-transform";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    query existingCartTransforms {
      cartTransforms(first: 1) {
        nodes {
          id
        }
      }
    }`);
  const { data } = await response.json();

  return { enabled: data.cartTransforms.nodes.length > 0 };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      mutation enableDepositCartTransform($functionHandle: String!) {
        cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: true) {
          cartTransform {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
    { variables: { functionHandle: CART_TRANSFORM_FUNCTION_HANDLE } },
  );
  const { data } = await response.json();
  const userErrors = data?.cartTransformCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return {
      error: userErrors.map((e: { message: string }) => e.message).join(", "),
    };
  }

  return { ok: true };
};

export default function Settings() {
  const { enabled } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state === "submitting";
  const isEnabled = enabled || fetcher.data?.ok === true;

  return (
    <s-page heading="Settings">
      <s-section heading="Checkout enforcement">
        <s-paragraph>
          Turning this on registers Pfandlock&apos;s Cart Transform function
          for your store, so any product with a configured deposit amount
          automatically adds that deposit as its own line in the cart and at
          checkout - buyers actually pay it, rather than just seeing it
          listed.
        </s-paragraph>
        <s-paragraph>
          Checkout is also automatically blocked if a product&apos;s deposit
          amount doesn&apos;t match any configured amount (for example, after
          an amount is removed) - that protection is always on and
          doesn&apos;t need to be enabled separately.
        </s-paragraph>

        {isEnabled ? (
          <s-badge tone="success">Enabled</s-badge>
        ) : (
          <s-badge>Not enabled</s-badge>
        )}

        {fetcher.data?.error && (
          <s-banner tone="critical">{fetcher.data.error}</s-banner>
        )}

        {!isEnabled && (
          <fetcher.Form method="post">
            <s-button
              variant="primary"
              type="submit"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Enable checkout enforcement
            </s-button>
          </fetcher.Form>
        )}
      </s-section>

      <s-section heading="Storefront deposit notice">
        <s-paragraph>
          Add the &quot;Deposit notice&quot; block to your product template
          from the theme editor (Online Store &gt; Customize) so buyers see a
          product&apos;s deposit amount before they add it to cart, instead
          of only at checkout.
        </s-paragraph>
      </s-section>

      <s-section heading="Advanced">
        <s-paragraph>
          Moving to another store? Export your deposit amounts and
          product assignments so they can be rebuilt there.
        </s-paragraph>
        <s-button href="/app/migration">Export configuration</s-button>
      </s-section>
    </s-page>
  );
}
