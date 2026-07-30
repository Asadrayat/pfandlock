// Server-side logic for the deposit ("Pfand") domain: the hidden deposit
// product/variants, deposit tiers, and reading a product's deposit status.
//
// Design recap (see conversation / project notes for the full reasoning):
// - Product-to-tier assignment lives on the product's own `$app:pfand` money
//   metafield, declared in shopify.app.toml. This module never stores that
//   assignment itself - it only reads it back and cross-references our tiers.
// - Our DB (DepositTier, ShopConfig) only tracks: which amounts are
//   configured, and which Shopify product/variant backs each amount's price.

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { formatAmount } from "./deposits.shared";

export { formatAmount, idFromGid } from "./deposits.shared";

export const PFAND_METAFIELD_NAMESPACE = "$app";
export const PFAND_METAFIELD_KEY = "pfand";

// Shop-level metafield the Cart Transform and Checkout Validation functions
// read their tier config from - Shopify Functions are sandboxed with no DB
// access, so this metafield is how the Postgres `DepositTier` table gets
// mirrored into something they can see. Kept in sync by
// `syncDepositTiersMetafield`, called whenever the tier list changes.
export const DEPOSIT_TIERS_METAFIELD_KEY = "deposit_tiers";

const DEPOSIT_PRODUCT_TITLE = "Pfand (Deposit)";
// The variant option every tier is distinguished by, e.g. "€0.08", "€0.15".
const DEPOSIT_OPTION_NAME = "Amount";

/** All configured deposit tiers for a shop, cheapest first. */
export async function listDepositTiers(shop: string) {
  return prisma.depositTier.findMany({
    where: { shop, active: true },
    orderBy: { amount: "asc" },
  });
}

/**
 * Mirrors the shop's active deposit tiers onto a `$app:deposit_tiers` JSON
 * metafield on the Shop itself, so the Cart Transform and Checkout
 * Validation functions - which can't reach Postgres - can read the current
 * amount -> variant mapping as part of their normal GraphQL input query.
 */
export async function syncDepositTiersMetafield(admin: AdminApiContext, shop: string) {
  const tiers = await listDepositTiers(shop);

  const shopResponse = await admin.graphql(`#graphql
    query shopId {
      shop {
        id
      }
    }`);
  const { data: shopData } = await shopResponse.json();

  const response = await admin.graphql(
    `#graphql
      mutation syncDepositTiers($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: shopData.shop.id,
            namespace: PFAND_METAFIELD_NAMESPACE,
            key: DEPOSIT_TIERS_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(
              tiers.map((tier) => ({
                amount: tier.amount,
                currency: tier.currency,
                variantId: tier.variantId,
              })),
            ),
          },
        ],
      },
    },
  );
  const { data } = await response.json();
  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Failed to sync deposit tiers metafield: ${userErrors.map((e: { message: string }) => e.message).join(", ")}`,
    );
  }
}

/**
 * Creates a new deposit tier: adds a priced variant for it on the shop's
 * hidden deposit product (creating that product on first use), then records
 * the tier in our DB.
 *
 * Uses `productSet`, which treats the `variants` array as the *complete*
 * variant list for the product - any existing variant omitted from the call
 * gets deleted. So every call here re-sends every existing tier's variant
 * (by id, so they're updated in place rather than recreated) alongside the
 * new one. This is what lets a single mutation both create-the-product-if-
 * needed and add-one-variant-without-losing-the-others.
 */
export async function createDepositTier(
  admin: AdminApiContext,
  shop: string,
  input: {
    amount: number; // minor units (cents)
    currency?: string;
    label?: string;
    chargeTax?: boolean;
  },
) {
  const currency = input.currency ?? "EUR";
  const existingTiers = await listDepositTiers(shop);

  const shopConfig = await prisma.shopConfig.findUnique({ where: { shop } });

  const newOptionValue = formatAmount(input.amount, currency);

  // Every existing tier becomes a variant entry keyed by its known
  // variantId, so productSet updates it in place instead of deleting it.
  const existingVariantInputs = existingTiers.map((tier) => ({
    id: tier.variantId,
    price: (tier.amount / 100).toFixed(2),
    optionValues: [{ optionName: DEPOSIT_OPTION_NAME, name: formatAmount(tier.amount, tier.currency) }],
  }));

  const newVariantInput = {
    price: (input.amount / 100).toFixed(2),
    optionValues: [{ optionName: DEPOSIT_OPTION_NAME, name: newOptionValue }],
  };

  const response = await admin.graphql(
    `#graphql
      mutation upsertDepositProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(input: $input, identifier: $identifier, synchronous: true) {
          product {
            id
            variants(first: 50) {
              nodes {
                id
                title
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        // Omitting `identifier` when the product doesn't exist yet tells
        // productSet to create a brand new product instead of updating one.
        identifier: shopConfig?.depositProductId
          ? { id: shopConfig.depositProductId }
          : undefined,
        input: {
          title: DEPOSIT_PRODUCT_TITLE,
          status: "ACTIVE",
          productOptions: [
            {
              name: DEPOSIT_OPTION_NAME,
              position: 1,
              values: [...existingTiers.map((t) => ({ name: formatAmount(t.amount, t.currency) })), { name: newOptionValue }],
            },
          ],
          variants: [...existingVariantInputs, newVariantInput],
        },
      },
    },
  );

  const { data } = await response.json();
  const userErrors = data?.productSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Failed to create deposit tier: ${userErrors.map((e: { message: string }) => e.message).join(", ")}`,
    );
  }

  const product = data.productSet.product;
  const createdVariant = product.variants.nodes.find(
    (v: { id: string; title: string }) => v.title === newOptionValue,
  );

  if (!shopConfig?.depositProductId) {
    await prisma.shopConfig.upsert({
      where: { shop },
      create: { shop, depositProductId: product.id },
      update: { depositProductId: product.id },
    });
  }

  const tier = await prisma.depositTier.create({
    data: {
      shop,
      amount: input.amount,
      currency,
      label: input.label,
      chargeTax: input.chargeTax ?? false,
      variantId: createdVariant.id,
    },
  });

  await syncDepositTiersMetafield(admin, shop);

  return tier;
}

export type ProductDepositStatus =
  | { state: "no-deposit" }
  | { state: "attaching"; tier: { amount: number; currency: string; label: string | null } }
  | { state: "orphaned"; amount: number; currency: string };

/**
 * Compares a product's raw `$app:pfand` metafield value against the shop's
 * configured tiers. A product can be tagged with an amount that has no
 * backing tier (e.g. the tier was deleted, or someone set the metafield by
 * hand) - that's the "orphaned" state the product list flags as blocking.
 */
export function resolveDepositStatus(
  metafieldValue: { amount: string; currencyCode: string } | null | undefined,
  tiers: Array<{ amount: number; currency: string; label: string | null }>,
): ProductDepositStatus {
  if (!metafieldValue) return { state: "no-deposit" };

  // Money metafields serialize `amount` as a decimal string ("0.08"), so we
  // round back to the same minor-unit representation tiers are stored in.
  const amount = Math.round(parseFloat(metafieldValue.amount) * 100);
  const currency = metafieldValue.currencyCode;

  const tier = tiers.find((t) => t.amount === amount && t.currency === currency);
  if (!tier) return { state: "orphaned", amount, currency };

  return { state: "attaching", tier };
}

export interface ProductWithDepositStatus {
  id: string;
  title: string;
  productType: string;
  totalVariants: number;
  imageUrl: string | null;
  price: string;
  currencyCode: string;
  status: ProductDepositStatus;
}

/** Fetches a page of products together with their deposit metafield/status. */
export async function listProductsWithDepositStatus(
  admin: AdminApiContext,
  shop: string,
  { first = 25 }: { first?: number } = {},
): Promise<ProductWithDepositStatus[]> {
  const tiers = await listDepositTiers(shop);

  const response = await admin.graphql(
    `#graphql
      query productsWithDeposit($first: Int!) {
        products(first: $first) {
          nodes {
            id
            title
            productType
            featuredMedia {
              preview { image { url } }
            }
            variantsCount { count }
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            pfand: metafield(namespace: "${PFAND_METAFIELD_NAMESPACE}", key: "${PFAND_METAFIELD_KEY}") {
              jsonValue
            }
          }
        }
      }`,
    { variables: { first } },
  );

  const { data } = await response.json();

  interface ProductNode {
    id: string;
    title: string;
    productType: string;
    featuredMedia?: { preview?: { image?: { url: string } } };
    variantsCount: { count: number };
    priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
    pfand?: { jsonValue?: { amount: string; currency_code: string } };
  }

  return (data.products.nodes as ProductNode[]).map((node) => {
    // A money metafield's jsonValue looks like {"amount":"0.08","currency_code":"EUR"}.
    const parsed = node.pfand?.jsonValue ?? null;
    const metafieldValue = parsed
      ? { amount: parsed.amount, currencyCode: parsed.currency_code }
      : null;

    return {
      id: node.id,
      title: node.title,
      productType: node.productType,
      totalVariants: node.variantsCount.count,
      imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
      price: node.priceRangeV2.minVariantPrice.amount,
      currencyCode: node.priceRangeV2.minVariantPrice.currencyCode,
      status: resolveDepositStatus(metafieldValue, tiers),
    };
  });
}

export interface ProductDepositDetail {
  id: string;
  title: string;
  vendor: string;
  totalVariants: number;
  status: ProductDepositStatus;
}

/** Fetches one product's basic info plus its deposit status, for the assign page. */
export async function getProductDepositDetail(
  admin: AdminApiContext,
  shop: string,
  productId: string,
): Promise<ProductDepositDetail | null> {
  const tiers = await listDepositTiers(shop);

  const response = await admin.graphql(
    `#graphql
      query productDepositDetail($id: ID!) {
        product(id: $id) {
          id
          title
          vendor
          variantsCount { count }
          pfand: metafield(namespace: "${PFAND_METAFIELD_NAMESPACE}", key: "${PFAND_METAFIELD_KEY}") {
            jsonValue
          }
        }
      }`,
    { variables: { id: productId } },
  );

  const { data } = await response.json();
  if (!data.product) return null;

  const parsed = data.product.pfand?.jsonValue ?? null;
  const metafieldValue = parsed
    ? { amount: parsed.amount, currencyCode: parsed.currency_code }
    : null;

  return {
    id: data.product.id,
    title: data.product.title,
    vendor: data.product.vendor,
    totalVariants: data.product.variantsCount.count,
    status: resolveDepositStatus(metafieldValue, tiers),
  };
}

/** Writes (or clears) a single product's deposit assignment. */
export async function setProductDeposit(
  admin: AdminApiContext,
  productId: string,
  tier: { amount: number; currency: string } | null,
) {
  if (!tier) {
    // Clearing the metafield removes the assignment entirely ("No deposit").
    const response = await admin.graphql(
      `#graphql
        mutation clearDeposit($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
      {
        variables: {
          metafields: [
            {
              ownerId: productId,
              namespace: PFAND_METAFIELD_NAMESPACE,
              key: PFAND_METAFIELD_KEY,
            },
          ],
        },
      },
    );
    const { data } = await response.json();
    const userErrors = data?.metafieldsDelete?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
    }
    return;
  }

  const response = await admin.graphql(
    `#graphql
      mutation setDeposit($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: PFAND_METAFIELD_NAMESPACE,
            key: PFAND_METAFIELD_KEY,
            type: "money",
            value: JSON.stringify({
              amount: (tier.amount / 100).toFixed(2),
              currency_code: tier.currency,
            }),
          },
        ],
      },
    },
  );
  const { data } = await response.json();
  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e: { message: string }) => e.message).join(", "));
  }
}
