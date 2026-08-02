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

/** The Cart Transform function that actually charges the deposit. */
export const CART_TRANSFORM_FUNCTION_HANDLE = "deposit-cart-transform";

const DEPOSIT_PRODUCT_TITLE = "Pfand (Deposit)";
// The variant option every tier is distinguished by, e.g. "€0.08", "€0.15".
const DEPOSIT_OPTION_NAME = "Amount";

/**
 * The deposit tiers a shop can currently charge, cheapest first.
 *
 * Active only - this is what the Functions get mirrored, and what a merchant
 * is offered when assigning a deposit to a product. Anything that has to
 * account for deactivated tiers too (the tier list a merchant manages, and
 * the deposit product's variant list) wants `listAllDepositTiers`.
 */
export async function listDepositTiers(shop: string) {
  return prisma.depositTier.findMany({
    where: { shop, active: true },
    orderBy: { amount: "asc" },
  });
}

/** Every tier a shop has ever configured, deactivated ones included. */
export async function listAllDepositTiers(shop: string) {
  return prisma.depositTier.findMany({
    where: { shop },
    orderBy: { amount: "asc" },
  });
}

/**
 * The currency a tier gets when none is given. Only reached by callers that
 * predate multi-currency support - the tier form always sends one explicitly,
 * and an EUR that isn't in the shop's list is rejected like any other.
 */
export const DEFAULT_CURRENCY = "EUR";

/**
 * Reads `ShopConfig.supportedCurrencies` back into an array.
 *
 * Deliberately total: the column is a plain string, so a hand-edited row or a
 * value written by an older/newer version of this code shouldn't crash the
 * page that reads it. Anything unparseable reads as "not detected yet", which
 * callers already have to handle.
 */
function parseSupportedCurrencies(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((code): code is string => typeof code === "string");
  } catch {
    return [];
  }
}

/**
 * Asks Shopify which currencies this shop can actually charge in and records
 * them on ShopConfig.
 *
 * `enabledPresentmentCurrencies` is the real source for this - it's the set a
 * buyer can be charged in across all of the shop's markets. (There is no
 * "sales channel currency" to query; channels don't carry one.) The shop's own
 * currency leads the list because that's what the deposit product's variants
 * are priced in, making it the currency a merchant almost always wants.
 *
 * Always re-queries rather than trusting what's stored: a merchant can add a
 * market long after installing, and a stale list would lock them out of a
 * currency they now sell in.
 */
export async function detectSupportedCurrencies(
  admin: AdminApiContext,
  shop: string,
): Promise<string[]> {
  const response = await admin.graphql(`#graphql
    query shopSupportedCurrencies {
      shop {
        currencyCode
        enabledPresentmentCurrencies
      }
    }`);
  const { data } = await response.json();

  const shopCurrency: string | undefined = data?.shop?.currencyCode;
  if (!shopCurrency) {
    throw new Error("Could not read this store's currency from Shopify.");
  }

  const presentment: string[] = data.shop.enabledPresentmentCurrencies ?? [];
  // Set preserves insertion order, so the shop currency stays first.
  const currencies = [...new Set([shopCurrency, ...presentment])];

  // Storing the answer is a cache, not the answer itself. A failed write
  // costs one extra API call next time and nothing else, so it must not take
  // down a page that already has what it asked for - which is exactly what
  // happened when a running server held a Prisma client from before this
  // column existed: Shopify returned the currencies, the cache write threw,
  // and the tier form went dark despite nothing being wrong with the shop.
  try {
    await prisma.shopConfig.upsert({
      where: { shop },
      create: { shop, supportedCurrencies: JSON.stringify(currencies) },
      update: { supportedCurrencies: JSON.stringify(currencies) },
    });
  } catch (error) {
    console.error(`Could not cache supported currencies for ${shop}:`, error);
  }

  return currencies;
}

/**
 * Whatever currency list is already on record, without calling Shopify.
 * Empty means detection hasn't succeeded for this shop yet.
 */
export async function readSupportedCurrencies(shop: string): Promise<string[]> {
  const config = await prisma.shopConfig.findUnique({ where: { shop } });
  return parseSupportedCurrencies(config?.supportedCurrencies);
}

/**
 * The stored currency list, detecting it first if the shop has none yet.
 *
 * For callers that need *an* answer rather than a fresh one - validating a
 * submitted tier, say. Pages that show the list to a merchant should call
 * `detectSupportedCurrencies` directly so newly added markets appear.
 */
export async function ensureSupportedCurrencies(
  admin: AdminApiContext,
  shop: string,
): Promise<string[]> {
  const stored = await readSupportedCurrencies(shop);
  if (stored.length > 0) return stored;

  return detectSupportedCurrencies(admin, shop);
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
 * Whether a write failed on a unique index - here, always the
 * `[shop, amount, currency]` one on DepositTier.
 *
 * Matched on the code rather than `instanceof PrismaClientKnownRequestError`,
 * so this doesn't depend on which copy of the Prisma runtime the error was
 * constructed by.
 */
function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
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
  const currency = input.currency ?? DEFAULT_CURRENCY;

  // A tier in a currency the shop can't charge in is worse than useless: both
  // functions match a product's `$app:pfand` currency against tier currencies
  // exactly, so every product assigned to it reads as orphaned and checkout is
  // blocked for those products. Checked here rather than only in the form,
  // because the action is reachable by direct POST.
  const supportedCurrencies = await ensureSupportedCurrencies(admin, shop);
  if (!supportedCurrencies.includes(currency)) {
    throw new Error(
      `${currency} isn't one of this store's currencies (${supportedCurrencies.join(", ")}). Deposits can only be charged in a currency the store sells in.`,
    );
  }

  // Deactivated tiers included, and that's load-bearing: productSet treats
  // `variants` as the product's complete list and deletes anything left out.
  // Sending only the active ones would destroy a deactivated tier's variant
  // the next time any tier is added - breaking carts that already hold that
  // deposit line, and leaving the tier pointing at a variant that's gone.
  const existingTiers = await listAllDepositTiers(shop);
  const shopConfig = await prisma.shopConfig.findUnique({ where: { shop } });

  const newOptionValue = formatAmount(input.amount, currency);

  // Caught before anything reaches Shopify. Letting productSet run first would
  // mint a variant for an amount the DB then refuses on its unique index,
  // leaving a priced variant on the deposit product with no tier behind it.
  const duplicate = existingTiers.find(
    (tier) => tier.amount === input.amount && tier.currency === currency,
  );
  if (duplicate) {
    throw new Error(
      duplicate.active
        ? `A deposit amount of ${newOptionValue} already exists.`
        : `A deposit amount of ${newOptionValue} already exists but is deactivated. Reactivate it instead of adding it again.`,
    );
  }

  // Every existing tier becomes a variant entry keyed by its known
  // variantId, so productSet updates it in place instead of deleting it.
  // `taxable` is re-sent with each one because productSet takes the entry as
  // the variant's whole desired state - omitting it would quietly reset every
  // existing tier's tax treatment to Shopify's default.
  const existingVariantInputs = existingTiers.map((tier) => ({
    id: tier.variantId,
    price: (tier.amount / 100).toFixed(2),
    taxable: tier.chargeTax,
    optionValues: [{ optionName: DEPOSIT_OPTION_NAME, name: formatAmount(tier.amount, tier.currency) }],
  }));

  const newVariantInput = {
    price: (input.amount / 100).toFixed(2),
    // What the merchant ticked on the form. Without this the deposit would be
    // taxed however Shopify defaults, regardless of what the app was told.
    taxable: input.chargeTax ?? false,
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

  let tier;
  try {
    tier = await prisma.depositTier.create({
      data: {
        shop,
        amount: input.amount,
        currency,
        label: input.label,
        chargeTax: input.chargeTax ?? false,
        variantId: createdVariant.id,
      },
    });
  } catch (error) {
    // The duplicate check above catches this in every ordinary case; what's
    // left is two tabs submitting the same amount at once. Prisma's raw text
    // names the database index, which means nothing to a merchant.
    if (isUniqueConstraintError(error)) {
      throw new Error(`A deposit amount of ${newOptionValue} already exists.`);
    }
    throw error;
  }

  await syncDepositTiersMetafield(admin, shop);

  return tier;
}

/**
 * Whether this app's deposit Cart Transform is registered for the shop -
 * which is what makes buyers actually get charged the deposit.
 *
 * Worth being precise about what this does and doesn't guard against.
 * `cartTransforms` is scoped to the calling app by Shopify, so another app's
 * bundle transform can never show up here and be mistaken for ours. What the
 * list *can* hold is more than one of this app's own transforms, if Pfandlock
 * ever ships a second cart transform function - so the deposit function is
 * matched by id instead of assuming whatever is first belongs to it.
 *
 * Read in three places (Settings, onboarding, migration export), which is why
 * it lives here rather than being spelled out at each one.
 */
export async function isDepositCartTransformActive(admin: AdminApiContext) {
  const response = await admin.graphql(`#graphql
    query depositCartTransform {
      cartTransforms(first: 10) {
        nodes {
          id
          functionId
        }
      }
      shopifyFunctions(first: 25, apiType: "cart_transform") {
        nodes {
          id
          handle
        }
      }
    }`);
  const { data } = await response.json();

  const transforms: Array<{ functionId: string }> = data?.cartTransforms?.nodes ?? [];
  const functions: Array<{ id: string; handle: string }> =
    data?.shopifyFunctions?.nodes ?? [];

  const depositFunctionIds = new Set(
    functions
      .filter((fn) => fn.handle === CART_TRANSFORM_FUNCTION_HANDLE)
      .map((fn) => fn.id),
  );

  // Nothing to match against - the function isn't deployed to this
  // environment, or the app can't see it. Since everything in `cartTransforms`
  // belongs to this app anyway, treating any registration as ours is both
  // safe and better than reporting "off" to a shop where it's demonstrably on.
  if (depositFunctionIds.size === 0) {
    return transforms.length > 0;
  }

  return transforms.some((transform) =>
    depositFunctionIds.has(transform.functionId),
  );
}

/**
 * Turns a deposit tier off (or back on).
 *
 * Soft, deliberately. Products carry their deposit as an amount on their own
 * metafield rather than a reference to a tier row, so deleting the row would
 * leave every product that used it pointing at an amount with nothing behind
 * it. Deactivating produces that same "orphaned" state on purpose - the
 * difference is it's reversible, and the backing variant survives so carts
 * that already hold the deposit line aren't broken.
 *
 * The DB write lands before the metafield sync on purpose. If the sync fails
 * the Functions keep seeing a tier the DB calls inactive, so the shop carries
 * on charging a deposit it meant to retire - annoying, and fixed by retrying.
 * The other order would leave products orphaned against a tier the DB still
 * calls active, which blocks checkout for them until someone notices.
 */
export async function setDepositTierActive(
  admin: AdminApiContext,
  shop: string,
  tierId: string,
  active: boolean,
) {
  // Scoped to the shop, not just the id: the id arrives from a form post, and
  // DepositTier is one table shared by every shop the app is installed on.
  const { count } = await prisma.depositTier.updateMany({
    where: { id: tierId, shop },
    data: { active },
  });

  if (count === 0) {
    throw new Error("That deposit amount no longer exists.");
  }

  // The Functions read tiers from the shop metafield, never from Postgres, so
  // nothing actually changes for a buyer until this runs.
  await syncDepositTiersMetafield(admin, shop);
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

export interface DashboardSummary {
  tiers: Array<{
    id: string;
    amount: number;
    currency: string;
    label: string | null;
    productCount: number;
  }>;
  totalProductCount: number;
  attachingCount: number;
  orphanedProducts: Array<{ id: string; title: string; amount: number; currency: string }>;
  cartTransformActive: boolean;
}

/**
 * Aggregates the real state the dashboard renders: tier config, product
 * coverage, and orphaned products. Scans up to 250 products (a single Admin
 * API page) for the coverage breakdown - fine at this app's current catalog
 * size, but won't reflect every product once a shop has more than that.
 * Deliberately has no notion of orders/collected-deposit totals - those
 * don't exist until Activity tracking is built, so the dashboard route
 * renders an empty state for them rather than calling this for numbers it
 * doesn't have.
 */
export async function getDashboardSummary(
  admin: AdminApiContext,
  shop: string,
): Promise<DashboardSummary> {
  const [tiers, countResponse, cartTransformActive, products] = await Promise.all([
    listDepositTiers(shop),
    admin.graphql(`#graphql
      query dashboardProductsCount {
        productsCount {
          count
        }
      }`),
    isDepositCartTransformActive(admin),
    listProductsWithDepositStatus(admin, shop, { first: 250 }),
  ]);

  const { data: countData } = await countResponse.json();

  let attachingCount = 0;
  const productCountByTier = new Map<string, number>();
  const orphanedProducts: DashboardSummary["orphanedProducts"] = [];
  for (const product of products) {
    if (product.status.state === "attaching") {
      attachingCount++;
      const tierKey = `${product.status.tier.amount}:${product.status.tier.currency}`;
      productCountByTier.set(tierKey, (productCountByTier.get(tierKey) ?? 0) + 1);
    }
    if (product.status.state === "orphaned") {
      orphanedProducts.push({
        id: product.id,
        title: product.title,
        amount: product.status.amount,
        currency: product.status.currency,
      });
    }
  }

  return {
    tiers: tiers.map((tier) => ({
      id: tier.id,
      amount: tier.amount,
      currency: tier.currency,
      label: tier.label,
      productCount: productCountByTier.get(`${tier.amount}:${tier.currency}`) ?? 0,
    })),
    totalProductCount: countData.productsCount.count,
    attachingCount,
    orphanedProducts,
    cartTransformActive,
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

/** Hard ceiling on the export's product scan - a runaway-pagination guard. */
const MIGRATION_PRODUCT_SCAN_LIMIT = 5000;

export interface MigrationExport {
  version: number;
  sourceShop: string;
  enforcementActive: boolean;
  tiers: Array<{
    amount: number;
    currency: string;
    label: string | null;
    chargeTax: boolean;
  }>;
  productAssignments: Array<{
    handle: string;
    title: string;
    skus: string[];
    amount: number;
    currency: string;
  }>;
  /** True when the scan hit MIGRATION_PRODUCT_SCAN_LIMIT and stopped early. */
  truncated: boolean;
}

/**
 * Builds the portable configuration for moving this setup to another store.
 *
 * Deliberately contains NO variant or product GIDs: those are per-store, and
 * hard-coding them is exactly what breaks a migration. Products are
 * identified by handle plus variant SKUs so the destination store can match
 * its own catalogue and re-derive its own ids.
 *
 * Paginates the whole catalogue rather than taking a single page like the
 * dashboard does - a dashboard that undercounts is a cosmetic bug, but an
 * export that silently omits products would hand the client a store where
 * some deposits just don't exist.
 */
export async function getMigrationExport(
  admin: AdminApiContext,
  shop: string,
): Promise<MigrationExport> {
  const [tiers, enforcementActive] = await Promise.all([
    listDepositTiers(shop),
    isDepositCartTransformActive(admin),
  ]);

  const { products, truncated } = await scanCatalogue(admin);

  const productAssignments: MigrationExport["productAssignments"] = [];
  for (const product of products) {
    if (!product.pfand) continue; // no deposit assigned - nothing to carry over
    productAssignments.push({
      handle: product.handle,
      title: product.title,
      skus: product.skus,
      // Stored in minor units to match DepositTier, not the metafield's
      // decimal string - the importer compares against tier amounts.
      amount: Math.round(parseFloat(product.pfand.amount) * 100),
      currency: product.pfand.currency_code,
    });
  }

  return {
    version: 1,
    sourceShop: shop,
    enforcementActive,
    tiers: tiers.map((tier) => ({
      amount: tier.amount,
      currency: tier.currency,
      label: tier.label,
      chargeTax: tier.chargeTax,
    })),
    productAssignments,
    truncated,
  };
}

interface ScannedProduct {
  id: string;
  handle: string;
  title: string;
  skus: string[];
  pfand: { amount: string; currency_code: string } | null;
}

/**
 * Walks the entire product catalogue once, capturing the identity fields
 * migration depends on (handle + SKUs) alongside each product's current
 * deposit metafield.
 *
 * Shared by export and import so the two can't drift: if export matches on
 * a field import doesn't collect, products silently fail to migrate.
 */
async function scanCatalogue(
  admin: AdminApiContext,
): Promise<{ products: ScannedProduct[]; truncated: boolean }> {
  interface ProductNode {
    id: string;
    handle: string;
    title: string;
    pfand?: { jsonValue?: { amount: string; currency_code: string } };
    variants: { nodes: Array<{ sku: string | null }> };
  }

  const products: ScannedProduct[] = [];
  let after: string | null = null;
  let truncated = false;

  for (;;) {
    const response: Response = await admin.graphql(
      `#graphql
        query migrationProducts($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              handle
              title
              pfand: metafield(namespace: "${PFAND_METAFIELD_NAMESPACE}", key: "${PFAND_METAFIELD_KEY}") {
                jsonValue
              }
              variants(first: 100) {
                nodes { sku }
              }
            }
          }
        }`,
      { variables: { first: 250, after } },
    );
    const { data } = await response.json();

    for (const node of data.products.nodes as ProductNode[]) {
      products.push({
        id: node.id,
        handle: node.handle,
        title: node.title,
        skus: node.variants.nodes
          .map((variant) => variant.sku)
          .filter((sku): sku is string => Boolean(sku)),
        pfand: node.pfand?.jsonValue ?? null,
      });
    }

    if (products.length >= MIGRATION_PRODUCT_SCAN_LIMIT) {
      truncated = data.products.pageInfo.hasNextPage;
      break;
    }
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }

  return { products, truncated };
}

const tierKey = (amount: number, currency: string) => `${amount}:${currency}`;

/**
 * Validates an uploaded configuration file. This is untrusted input - a
 * merchant can hand-edit or upload anything - so every field is checked
 * rather than cast, and a bad file fails loudly here instead of producing
 * a half-applied import later.
 */
export function parseMigrationExportFile(raw: string): MigrationExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("That file doesn't look like a Pfandlock configuration.");
  }
  const doc = parsed as Record<string, unknown>;

  if (doc.version !== 1) {
    throw new Error(
      `Unsupported configuration version: ${String(doc.version)}. This app reads version 1.`,
    );
  }
  if (!Array.isArray(doc.tiers) || !Array.isArray(doc.productAssignments)) {
    throw new Error(
      "That configuration is missing its deposit amounts or product assignments.",
    );
  }

  const tiers = doc.tiers.map((entry, index) => {
    const tier = entry as Record<string, unknown>;
    if (!Number.isInteger(tier.amount) || (tier.amount as number) <= 0) {
      throw new Error(`Deposit amount #${index + 1} has an invalid amount.`);
    }
    if (typeof tier.currency !== "string" || !tier.currency) {
      throw new Error(`Deposit amount #${index + 1} has no currency.`);
    }
    return {
      amount: tier.amount as number,
      currency: tier.currency,
      label: typeof tier.label === "string" ? tier.label : null,
      chargeTax: tier.chargeTax === true,
    };
  });

  const productAssignments = doc.productAssignments.map((entry, index) => {
    const product = entry as Record<string, unknown>;
    if (typeof product.handle !== "string" || !product.handle) {
      throw new Error(`Product assignment #${index + 1} has no handle.`);
    }
    if (!Number.isInteger(product.amount) || (product.amount as number) <= 0) {
      throw new Error(`Product assignment #${index + 1} has an invalid amount.`);
    }
    if (typeof product.currency !== "string" || !product.currency) {
      throw new Error(`Product assignment #${index + 1} has no currency.`);
    }
    return {
      handle: product.handle,
      title: typeof product.title === "string" ? product.title : product.handle,
      skus: Array.isArray(product.skus)
        ? product.skus.filter((sku): sku is string => typeof sku === "string")
        : [],
      amount: product.amount as number,
      currency: product.currency,
    };
  });

  return {
    version: 1,
    sourceShop: typeof doc.sourceShop === "string" ? doc.sourceShop : "unknown",
    enforcementActive: doc.enforcementActive === true,
    tiers,
    productAssignments,
    truncated: doc.truncated === true,
  };
}

export interface MigrationImportPlan {
  sourceShop: string;
  tiersToCreate: Array<{ amount: number; currency: string; label: string | null }>;
  tiersAlreadyPresent: Array<{ amount: number; currency: string }>;
  matched: Array<{
    handle: string;
    title: string;
    productId: string;
    amount: number;
    currency: string;
    matchedBy: "sku" | "handle";
    alreadyCorrect: boolean;
  }>;
  unmatched: Array<{ handle: string; title: string }>;
  /** Matched products whose amount still won't have a tier after import. */
  missingTier: Array<{ handle: string; title: string; amount: number; currency: string }>;
  sourceTruncated: boolean;
  destinationTruncated: boolean;
}

/**
 * Works out exactly what an import would do, without changing anything.
 *
 * Import is additive by design: it never deletes a tier or clears a deposit
 * the destination store already has. A store being migrated into may already
 * be partly configured, and a "restore from file" that silently removed
 * local work would be far worse than one that leaves a duplicate to resolve
 * by hand.
 */
export async function previewMigrationImport(
  admin: AdminApiContext,
  shop: string,
  data: MigrationExport,
): Promise<MigrationImportPlan> {
  const [existingTiers, { products, truncated }] = await Promise.all([
    listDepositTiers(shop),
    scanCatalogue(admin),
  ]);

  const existingTierKeys = new Set(
    existingTiers.map((tier) => tierKey(tier.amount, tier.currency)),
  );

  const tiersToCreate = data.tiers.filter(
    (tier) => !existingTierKeys.has(tierKey(tier.amount, tier.currency)),
  );
  const tiersAlreadyPresent = data.tiers.filter((tier) =>
    existingTierKeys.has(tierKey(tier.amount, tier.currency)),
  );

  // Index the destination catalogue once rather than querying per product -
  // a few hundred assignments would otherwise mean a few hundred round trips.
  const bySku = new Map<string, ScannedProduct>();
  const byHandle = new Map<string, ScannedProduct>();
  for (const product of products) {
    byHandle.set(product.handle, product);
    for (const sku of product.skus) {
      if (!bySku.has(sku)) bySku.set(sku, product);
    }
  }

  const tierKeysAfterImport = new Set([
    ...existingTierKeys,
    ...tiersToCreate.map((tier) => tierKey(tier.amount, tier.currency)),
  ]);

  const matched: MigrationImportPlan["matched"] = [];
  const unmatched: MigrationImportPlan["unmatched"] = [];
  const missingTier: MigrationImportPlan["missingTier"] = [];

  for (const assignment of data.productAssignments) {
    // SKU first: handles are editable per store, SKUs are the stable
    // cross-store identifier a merchant actually maintains.
    let match: ScannedProduct | undefined;
    let matchedBy: "sku" | "handle" = "sku";
    for (const sku of assignment.skus) {
      const candidate = bySku.get(sku);
      if (candidate) {
        match = candidate;
        break;
      }
    }
    if (!match) {
      match = byHandle.get(assignment.handle);
      matchedBy = "handle";
    }

    if (!match) {
      unmatched.push({ handle: assignment.handle, title: assignment.title });
      continue;
    }

    const currentAmount = match.pfand
      ? Math.round(parseFloat(match.pfand.amount) * 100)
      : null;

    matched.push({
      handle: assignment.handle,
      title: match.title,
      productId: match.id,
      amount: assignment.amount,
      currency: assignment.currency,
      matchedBy,
      alreadyCorrect:
        currentAmount === assignment.amount &&
        match.pfand?.currency_code === assignment.currency,
    });

    if (!tierKeysAfterImport.has(tierKey(assignment.amount, assignment.currency))) {
      missingTier.push({
        handle: assignment.handle,
        title: match.title,
        amount: assignment.amount,
        currency: assignment.currency,
      });
    }
  }

  return {
    sourceShop: data.sourceShop,
    tiersToCreate,
    tiersAlreadyPresent: tiersAlreadyPresent.map((tier) => ({
      amount: tier.amount,
      currency: tier.currency,
    })),
    matched,
    unmatched,
    missingTier,
    sourceTruncated: data.truncated,
    destinationTruncated: truncated,
  };
}

export interface MigrationImportResult {
  tiersCreated: number;
  productsAssigned: number;
  productsSkipped: number;
  unmatched: number;
}

/** How many metafields `metafieldsSet` accepts in one call. */
const METAFIELDS_SET_BATCH_SIZE = 25;

/**
 * Applies an import plan. Re-previews first rather than trusting a plan
 * round-tripped through the browser, so what gets written is always derived
 * from the store's current state, not from whatever the client posted back.
 */
export async function applyMigrationImport(
  admin: AdminApiContext,
  shop: string,
  data: MigrationExport,
): Promise<MigrationImportResult> {
  const plan = await previewMigrationImport(admin, shop, data);

  // Sequential, not parallel: each createDepositTier re-sends the deposit
  // product's whole variant list via productSet, so concurrent calls would
  // race and drop each other's variants.
  for (const tier of plan.tiersToCreate) {
    await createDepositTier(admin, shop, {
      amount: tier.amount,
      currency: tier.currency,
      label: tier.label ?? undefined,
    });
  }

  const toAssign = plan.matched.filter((product) => !product.alreadyCorrect);

  for (let i = 0; i < toAssign.length; i += METAFIELDS_SET_BATCH_SIZE) {
    const batch = toAssign.slice(i, i + METAFIELDS_SET_BATCH_SIZE);
    const response = await admin.graphql(
      `#graphql
        mutation importSetDeposits($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
      {
        variables: {
          metafields: batch.map((product) => ({
            ownerId: product.productId,
            namespace: PFAND_METAFIELD_NAMESPACE,
            key: PFAND_METAFIELD_KEY,
            type: "money",
            value: JSON.stringify({
              amount: (product.amount / 100).toFixed(2),
              currency_code: product.currency,
            }),
          })),
        },
      },
    );
    const { data: batchData } = await response.json();
    const userErrors = batchData?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(
        `Failed to assign deposits: ${userErrors.map((e: { message: string }) => e.message).join(", ")}`,
      );
    }
  }

  return {
    tiersCreated: plan.tiersToCreate.length,
    productsAssigned: toAssign.length,
    productsSkipped: plan.matched.length - toAssign.length,
    unmatched: plan.unmatched.length,
  };
}

export interface OnboardingStatus {
  depositProduct: { id: string; title: string; variantCount: number } | null;
  pfandFieldDefined: boolean;
  tiers: Array<{ id: string; amount: number; currency: string; label: string | null }>;
  cartTransformActive: boolean;
  shop: {
    plan: string;
    isPlus: boolean;
    isDevelopment: boolean;
    storefrontUrl: string;
  };
  completedSteps: number;
  totalSteps: number;
}

/**
 * Reflects the real setup state behind the four onboarding steps. Every
 * field is queried, never assumed - a merchant can undo any of these from
 * the Shopify admin (delete the deposit product, remove every tier), and
 * this page has to show that honestly rather than remembering it was once
 * "done".
 *
 * Step 2 (the `$app:pfand` product field) is a special case: it's declared
 * declaratively in shopify.app.toml, so `shopify app deploy` creates it and
 * no merchant action can complete it. It's still queried rather than
 * hardcoded true, because a failed/partial deploy is exactly the situation
 * where a merchant needs to see it missing.
 */
export async function getOnboardingStatus(
  admin: AdminApiContext,
  shop: string,
): Promise<OnboardingStatus> {
  const [tiers, shopConfig, fieldResponse, cartTransformActive, shopResponse] =
    await Promise.all([
      listDepositTiers(shop),
      prisma.shopConfig.findUnique({ where: { shop } }),
      admin.graphql(`#graphql
        query onboardingPfandField {
          metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: "${PFAND_METAFIELD_NAMESPACE}", key: "${PFAND_METAFIELD_KEY}") {
            nodes {
              id
            }
          }
        }`),
      isDepositCartTransformActive(admin),
      admin.graphql(`#graphql
        query onboardingShop {
          shop {
            myshopifyDomain
            primaryDomain {
              url
            }
            plan {
              publicDisplayName
              partnerDevelopment
              shopifyPlus
            }
          }
        }`),
    ]);

  const { data: fieldData } = await fieldResponse.json();
  const { data: shopData } = await shopResponse.json();

  // The stored product id can outlive the product itself (a merchant can
  // delete it from the admin), so confirm it still resolves before calling
  // step 1 done.
  let depositProduct: OnboardingStatus["depositProduct"] = null;
  if (shopConfig?.depositProductId) {
    const productResponse = await admin.graphql(
      `#graphql
        query onboardingDepositProduct($id: ID!) {
          product(id: $id) {
            id
            title
            variantsCount { count }
          }
        }`,
      { variables: { id: shopConfig.depositProductId } },
    );
    const { data: productData } = await productResponse.json();
    if (productData?.product) {
      depositProduct = {
        id: productData.product.id,
        title: productData.product.title,
        variantCount: productData.product.variantsCount.count,
      };
    }
  }

  const pfandFieldDefined = fieldData.metafieldDefinitions.nodes.length > 0;

  const completedSteps = [
    depositProduct !== null,
    pfandFieldDefined,
    tiers.length > 0,
    cartTransformActive,
  ].filter(Boolean).length;

  return {
    depositProduct,
    pfandFieldDefined,
    tiers: tiers.map((tier) => ({
      id: tier.id,
      amount: tier.amount,
      currency: tier.currency,
      label: tier.label,
    })),
    cartTransformActive,
    shop: {
      plan: shopData.shop.plan.publicDisplayName,
      isPlus: shopData.shop.plan.shopifyPlus,
      isDevelopment: shopData.shop.plan.partnerDevelopment,
      storefrontUrl:
        shopData.shop.primaryDomain?.url ?? `https://${shopData.shop.myshopifyDomain}`,
    },
    completedSteps,
    totalSteps: 4,
  };
}

export interface ActivityEvent {
  id: string;
  message: string;
  detail: string | null;
  when: Date;
}

export interface ActivitySummary {
  events: ActivityEvent[];
  configChangeCount: number;
}

/**
 * The only real activity signal this app currently has: DepositTier rows'
 * own createdAt/updatedAt timestamps. There's no dedicated audit log (no
 * record of *who* made a change, and no events for product assignments or
 * settings toggles), and no way to observe blocked checkouts or runtime
 * errors here - Shopify doesn't expose validation-function outcomes to
 * apps (a validation error surfaces only to the buyer's own cart/checkout,
 * never back to the app), and this app doesn't log its own errors anywhere
 * yet. The route renders honest empty states for both rather than
 * pretending either is tracked.
 */
export async function getActivitySummary(shop: string): Promise<ActivitySummary> {
  const tiers = await prisma.depositTier.findMany({ where: { shop } });

  const events: ActivityEvent[] = tiers.map((tier) => {
    const wasEdited = tier.updatedAt.getTime() !== tier.createdAt.getTime();
    return {
      id: tier.id,
      message: `${formatAmount(tier.amount, tier.currency)} amount ${wasEdited ? "updated" : "added"}`,
      detail: tier.label,
      when: wasEdited ? tier.updatedAt : tier.createdAt,
    };
  });

  events.sort((a, b) => b.when.getTime() - a.when.getTime());

  return { events, configChangeCount: events.length };
}
