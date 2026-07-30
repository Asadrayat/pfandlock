// "Deposit products" admin page. Lists products alongside the deposit
// status derived from their `$app:pfand` metafield (see
// app/deposits.server.ts#resolveDepositStatus for the three possible
// states: attaching, orphaned/no-matching-amount, or no deposit).
//
// This is a read-only list for Phase 1 - assigning/changing a product's
// tier happens on the per-product page (app.products.$id.tsx).
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listProductsWithDepositStatus } from "app/deposits.server";
import { formatAmount, idFromGid } from "app/deposits.shared";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const products = await listProductsWithDepositStatus(admin, session.shop, {
    first: 25,
  });
  // console.log(products);
  
  return { products };
};

export default function ProductsIndex() {
  const { products } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Deposit products">
      <s-section>
        {products.length === 0 ? (
          <s-paragraph>No products found.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header format="currency">Price</s-table-header>
              <s-table-header>Deposit</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((product) => (
                <s-table-row key={product.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      {product.imageUrl && (
                        <s-thumbnail
                          src={product.imageUrl}
                          alt={product.title}
                          size="small"
                        />
                      )}
                      <s-stack direction="block" gap="small-100">
                        <s-text>{product.title}</s-text>
                        <s-text color="subdued">
                          {product.totalVariants}{" "}
                          {product.totalVariants === 1 ? "variant" : "variants"}
                        </s-text>
                      </s-stack>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{product.productType || "—"}</s-table-cell>
                  <s-table-cell>
                    {formatAmount(
                      Math.round(parseFloat(product.price) * 100),
                      product.currencyCode,
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {product.status.state === "attaching" && (
                      <strong>
                        {formatAmount(
                          product.status.tier.amount,
                          product.status.tier.currency,
                        )}
                      </strong>
                    )}
                    {product.status.state === "orphaned" && (
                      <strong>
                        {formatAmount(product.status.amount, product.status.currency)}
                      </strong>
                    )}
                    {product.status.state === "no-deposit" && (
                      <s-text color="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {product.status.state === "attaching" && (
                      <s-badge tone="success">Attaching</s-badge>
                    )}
                    {product.status.state === "orphaned" && (
                      <s-badge tone="critical">No matching amount</s-badge>
                    )}
                    {product.status.state === "no-deposit" && (
                      <s-badge>No deposit</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/products/${idFromGid(product.id)}`}>
                      {product.status.state === "no-deposit" ? "Assign" : "Edit"}
                    </s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
