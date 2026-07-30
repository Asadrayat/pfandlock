// "Assign deposit" page for a single product. Lets a merchant pick which
// configured deposit tier applies to this product (or none), which just
// writes/clears the product's `$app:pfand` metafield - see
// app/deposits.server.ts#setProductDeposit.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import {
  formatAmount,
  getProductDepositDetail,
  listDepositTiers,
  setProductDeposit,
} from "../deposits.server";

function productGid(id: string | undefined) {
  return `gid://shopify/Product/${id}`;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [product, tiers] = await Promise.all([
    getProductDepositDetail(admin, session.shop, productGid(params.id)),
    listDepositTiers(session.shop),
  ]);

  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  // Resolve which tier (if any) the product's current metafield matches, so
  // the choice list can pre-select it. Narrowed through a local `status`
  // const - TS won't narrow `product.status` itself inside the `.find`
  // callback below.
  const status = product.status;
  const currentTierId =
    status.state === "attaching"
      ? (tiers.find(
          (t) => t.amount === status.tier.amount && t.currency === status.tier.currency,
        )?.id ?? null)
      : null;

  return {
    product,
    currentTierId,
    isOrphaned: product.status.state === "orphaned",
    tiers: tiers.map((t) => ({
      id: t.id,
      label: t.label,
      display: formatAmount(t.amount, t.currency),
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const tierId = String(formData.get("tier") || "none");

  if (tierId === "none") {
    await setProductDeposit(admin, productGid(params.id), null);
    return { ok: true };
  }

  const tiers = await listDepositTiers(session.shop);
  const tier = tiers.find((t) => t.id === tierId);
  if (!tier) {
    return { error: "That deposit amount no longer exists." };
  }

  await setProductDeposit(admin, productGid(params.id), {
    amount: tier.amount,
    currency: tier.currency,
  });
  return { ok: true };
};

export default function AssignDeposit() {
  const { product, tiers, currentTierId, isOrphaned } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state === "submitting";

  return (
    <s-page heading={product.title} inlineSize="small">
      <s-link slot="breadcrumb-actions" href="/app/products">
        Deposit products
      </s-link>

      <s-section heading="Deposit amount">
        <s-paragraph>
          Charged once per unit and refunded when the container comes back.
          It&apos;s added to the cart automatically - you don&apos;t need to
          price it into the product.
        </s-paragraph>

        {isOrphaned && (
          <s-banner tone="warning" heading="No matching deposit amount">
            This product&apos;s current deposit doesn&apos;t match any
            configured amount. Pick one below to fix it.
          </s-banner>
        )}

        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-choice-list name="tier" label="Deposit amount" values={[currentTierId ?? "none"]}>
              {tiers.map((tier) => (
                <s-choice key={tier.id} value={tier.id}>
                  {tier.display}
                  {tier.label ? ` — ${tier.label}` : ""}
                </s-choice>
              ))}
              <s-choice value="none">No deposit</s-choice>
            </s-choice-list>

            {fetcher.data?.error && (
              <s-banner tone="critical">{fetcher.data.error}</s-banner>
            )}

            <s-button
              variant="primary"
              type="submit"
              {...(isSubmitting ? { loading: true } : {})}
            >
              Save
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>
    </s-page>
  );
}
