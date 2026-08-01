// Unit tests for the deposit domain logic that has no business talking to
// Shopify: money conversion, deposit-status resolution, the untrusted-file
// parser, and the import planner.
//
// The planner is the reason this file exists. `previewMigrationImport` is
// what a merchant reads before letting the app rewrite metafields on a live
// store, so a wrong match or a missed "orphaned amount" warning is a bug
// they only find out about after the damage. It's also the one piece that
// can't be checked by reading it - the SKU/handle fallback and the
// already-correct comparison only misbehave on specific combinations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

vi.mock("./db.server", () => ({
  default: {
    depositTier: { findMany: vi.fn(), create: vi.fn() },
    shopConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import prisma from "./db.server";
import {
  applyMigrationImport,
  formatAmount,
  getMigrationExport,
  getOnboardingStatus,
  idFromGid,
  parseMigrationExportFile,
  previewMigrationImport,
  resolveDepositStatus,
  type MigrationExport,
} from "./deposits.server";
import { formatRelativeTime } from "./deposits.shared";

const findMany = vi.mocked(prisma.depositTier.findMany);
const createTierRow = vi.mocked(prisma.depositTier.create);
const findShopConfig = vi.mocked(prisma.shopConfig.findUnique);
const upsertShopConfig = vi.mocked(prisma.shopConfig.upsert);

const SHOP = "new.myshopify.com";

/**
 * Prisma's methods return a PrismaPromise - an ordinary promise branded with
 * a toStringTag so its fluent API can be typed. `mockResolvedValue` handles
 * that for us, but a mock that has to compute its answer needs to hand back
 * the branded shape itself. Nothing here behaves differently at runtime.
 */
const prismaResult = <T>(value: T) => {
  const promise = Promise.resolve(value);
  // defineProperty, not assignment: Symbol.toStringTag is inherited from
  // Promise.prototype as a non-writable property, so a plain set throws.
  Object.defineProperty(promise, Symbol.toStringTag, { value: "PrismaPromise" });
  return promise as Promise<T> & { readonly [Symbol.toStringTag]: "PrismaPromise" };
};

/**
 * A full DepositTier row from just the fields a test cares about. The code
 * under test reads a handful of them, but the mocks have to satisfy Prisma's
 * real return type, and spelling the rest out at each call site would bury
 * what the test is actually varying.
 */
const tierRow = (
  amount: number,
  overrides: { currency?: string; label?: string | null; variantId?: string } = {},
) => {
  const currency = overrides.currency ?? "EUR";
  return {
    id: `tier-${amount}-${currency}`,
    shop: SHOP,
    amount,
    currency,
    label: overrides.label ?? null,
    variantId: overrides.variantId ?? `gid://shopify/ProductVariant/tier-${amount}`,
    chargeTax: false,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
};

beforeEach(() => {
  // reset, not clear: clearAllMocks wipes recorded calls but leaves any
  // mockImplementation in place, so a fake store built in one suite would
  // still be answering queries in the next one.
  vi.resetAllMocks();
});

interface CatalogueProduct {
  id: string;
  handle: string;
  title: string;
  /** null models a variant with no SKU set, which the real API returns. */
  skus?: Array<string | null>;
  pfand?: { amount: string; currency_code: string } | null;
}

/** One product as the migration catalogue query returns it. */
const catalogueNode = (product: CatalogueProduct) => ({
  id: product.id,
  handle: product.handle,
  title: product.title,
  pfand: product.pfand ? { jsonValue: product.pfand } : null,
  variants: { nodes: (product.skus ?? []).map((sku) => ({ sku })) },
});

const file = (overrides: Partial<MigrationExport> = {}): MigrationExport => ({
  version: 1,
  sourceShop: "old-store.myshopify.com",
  enforcementActive: true,
  tiers: [{ amount: 8, currency: "EUR", label: "Bottle", chargeTax: false }],
  productAssignments: [],
  truncated: false,
  ...overrides,
});

const assignment = (
  overrides: Partial<MigrationExport["productAssignments"][number]> = {},
) => ({
  handle: "sparkling-water",
  title: "Sparkling Water",
  skus: ["SKU-1"],
  amount: 8,
  currency: "EUR",
  ...overrides,
});

/**
 * Intl puts a non-breaking space before the currency symbol, and which one
 * varies with the ICU build. Normalising keeps these assertions about the
 * formatting we control (separator, symbol, decimal places) rather than
 * about the Node version running them.
 */
const spaces = (value: string) => value.replace(/[\u00a0\u202f]/g, " ");

describe("formatAmount", () => {
  it("renders minor units as German-locale currency", () => {
    expect(spaces(formatAmount(8))).toBe("0,08 €");
    expect(spaces(formatAmount(1550))).toBe("15,50 €");
  });

  it("defaults to EUR but honours an explicit currency", () => {
    expect(spaces(formatAmount(800, "USD"))).toBe("8,00 $");
  });

  it("always shows two decimals, so amounts line up in a column", () => {
    expect(spaces(formatAmount(100))).toBe("1,00 €");
  });
});

describe("idFromGid", () => {
  it("takes the numeric id off the end of a GID", () => {
    expect(idFromGid("gid://shopify/Product/123")).toBe("123");
    expect(idFromGid("gid://shopify/ProductVariant/456")).toBe("456");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-03-10T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const minutes = 60_000;
  const hours = 60 * minutes;
  const days = 24 * hours;

  it("collapses anything under a minute", () => {
    expect(formatRelativeTime(ago(20_000), now)).toBe("Just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(formatRelativeTime(ago(11 * minutes), now)).toBe("11 min ago");
    expect(formatRelativeTime(ago(2 * hours), now)).toBe("2 h ago");
    expect(formatRelativeTime(ago(3 * days), now)).toBe("3 days ago");
  });

  it("names the day before rather than counting it", () => {
    expect(formatRelativeTime(ago(25 * hours), now)).toBe("Yesterday");
  });

  it("falls back to a date once relative time stops being useful", () => {
    expect(formatRelativeTime(ago(30 * days), now)).toBe("8 Feb");
  });
});

describe("resolveDepositStatus", () => {
  const tiers = [
    { amount: 8, currency: "EUR", label: "Single-use bottle" },
    { amount: 15, currency: "EUR", label: null },
  ];

  it("reports no deposit when the metafield is unset", () => {
    expect(resolveDepositStatus(null, tiers)).toEqual({ state: "no-deposit" });
    expect(resolveDepositStatus(undefined, tiers)).toEqual({
      state: "no-deposit",
    });
  });

  it("attaches the matching tier, label included", () => {
    expect(
      resolveDepositStatus({ amount: "0.08", currencyCode: "EUR" }, tiers),
    ).toEqual({ state: "attaching", tier: tiers[0] });
  });

  it("flags an amount with no configured tier as orphaned", () => {
    expect(
      resolveDepositStatus({ amount: "0.25", currencyCode: "EUR" }, tiers),
    ).toEqual({ state: "orphaned", amount: 25, currency: "EUR" });
  });

  it("treats a currency mismatch as orphaned, not as a match", () => {
    // A shop selling in two currencies could hold both an 8 EUR and an 8 USD
    // tier; matching on amount alone would silently charge the wrong one.
    expect(
      resolveDepositStatus({ amount: "0.08", currencyCode: "USD" }, tiers),
    ).toEqual({ state: "orphaned", amount: 8, currency: "USD" });
  });

  it("survives the float that decimal money strings produce", () => {
    // 0.29 * 100 is 28.999999999999996 - truncating instead of rounding
    // would orphan a perfectly good 29-cent deposit.
    expect(
      resolveDepositStatus({ amount: "0.29", currencyCode: "EUR" }, [
        { amount: 29, currency: "EUR", label: null },
      ]),
    ).toEqual({
      state: "attaching",
      tier: { amount: 29, currency: "EUR", label: null },
    });
  });
});

describe("parseMigrationExportFile", () => {
  const valid = {
    version: 1,
    sourceShop: "old-store.myshopify.com",
    enforcementActive: true,
    tiers: [{ amount: 8, currency: "EUR", label: "Bottle", chargeTax: false }],
    productAssignments: [
      {
        handle: "sparkling-water",
        title: "Sparkling Water",
        skus: ["SKU-1"],
        amount: 8,
        currency: "EUR",
      },
    ],
    truncated: false,
  };
  const parse = (doc: unknown) => parseMigrationExportFile(JSON.stringify(doc));

  it("round-trips a file this app produced", () => {
    expect(parse(valid)).toEqual(valid);
  });

  it("rejects input that isn't JSON at all", () => {
    expect(() => parseMigrationExportFile("not json")).toThrow(
      "That file isn't valid JSON.",
    );
  });

  it("rejects JSON that isn't a configuration object", () => {
    expect(() => parseMigrationExportFile("42")).toThrow(
      "doesn't look like a Pfandlock configuration",
    );
    expect(() => parseMigrationExportFile("null")).toThrow(
      "doesn't look like a Pfandlock configuration",
    );
  });

  it("names the version it can't read", () => {
    expect(() => parse({ ...valid, version: 2 })).toThrow(
      "Unsupported configuration version: 2",
    );
  });

  it("rejects a file missing either list", () => {
    expect(() => parse({ ...valid, tiers: undefined })).toThrow(
      "missing its deposit amounts or product assignments",
    );
    expect(() => parse({ ...valid, productAssignments: undefined })).toThrow(
      "missing its deposit amounts or product assignments",
    );
  });

  it("rejects amounts that aren't positive whole minor units", () => {
    // A decimal here means someone hand-edited euros into a cents field;
    // importing it would create a tier priced 100x wrong.
    for (const amount of [0, -8, 8.5, "8", null]) {
      expect(() => parse({ ...valid, tiers: [{ ...valid.tiers[0], amount }] })).toThrow(
        "Deposit amount #1 has an invalid amount.",
      );
    }
  });

  it("rejects a tier with no currency", () => {
    expect(() => parse({ ...valid, tiers: [{ amount: 8, currency: "" }] })).toThrow(
      "Deposit amount #1 has no currency.",
    );
  });

  it("points at which product assignment is broken", () => {
    const assignments = [
      valid.productAssignments[0],
      { ...valid.productAssignments[0], handle: "" },
    ];
    expect(() => parse({ ...valid, productAssignments: assignments })).toThrow(
      "Product assignment #2 has no handle.",
    );
  });

  it("rejects a product assignment with an invalid amount or currency", () => {
    expect(() =>
      parse({
        ...valid,
        productAssignments: [{ ...valid.productAssignments[0], amount: 0 }],
      }),
    ).toThrow("Product assignment #1 has an invalid amount.");
    expect(() =>
      parse({
        ...valid,
        productAssignments: [
          { ...valid.productAssignments[0], currency: undefined },
        ],
      }),
    ).toThrow("Product assignment #1 has no currency.");
  });

  it("fills in the optional fields rather than failing on them", () => {
    const parsed = parseMigrationExportFile(
      JSON.stringify({
        version: 1,
        tiers: [{ amount: 8, currency: "EUR", label: 42 }],
        productAssignments: [
          { handle: "water", amount: 8, currency: "EUR", skus: ["A", 7, null] },
        ],
      }),
    );

    expect(parsed.tiers[0]).toEqual({
      amount: 8,
      currency: "EUR",
      label: null,
      chargeTax: false,
    });
    // Title falls back to the handle, and non-string SKUs are dropped rather
    // than carried through to a match that could never succeed.
    expect(parsed.productAssignments[0].title).toBe("water");
    expect(parsed.productAssignments[0].skus).toEqual(["A"]);
    expect(parsed.sourceShop).toBe("unknown");
    expect(parsed.enforcementActive).toBe(false);
    expect(parsed.truncated).toBe(false);
  });
});

describe("previewMigrationImport", () => {
  /** An admin client that replays fixed catalogue pages, one per call. */
  const fakeAdmin = (
    pages: Array<{ products: CatalogueProduct[]; hasNextPage?: boolean }>,
  ) => {
    let call = 0;
    const graphql = vi.fn(async () => {
      const page = pages[call++];
      return {
        json: async () => ({
          data: {
            products: {
              pageInfo: {
                hasNextPage: page.hasNextPage ?? false,
                endCursor: `cursor-${call}`,
              },
              nodes: page.products.map(catalogueNode),
            },
          },
        }),
      };
    });
    return { admin: { graphql } as unknown as AdminApiContext, graphql };
  };

  it("prefers a SKU match over a handle match", async () => {
    // Handles get renamed per store; the SKU is what the merchant actually
    // keeps stable, so a handle collision must not win.
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([
      {
        products: [
          { id: "gid://shopify/Product/1", handle: "sparkling-water", title: "Decoy" },
          {
            id: "gid://shopify/Product/2",
            handle: "renamed-water",
            title: "Sparkling Water",
            skus: ["SKU-1"],
          },
        ],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment()],
    }));

    expect(plan.matched).toHaveLength(1);
    expect(plan.matched[0].productId).toBe("gid://shopify/Product/2");
    expect(plan.matched[0].matchedBy).toBe("sku");
    // The title reported back is the destination's, not the file's - that's
    // what the merchant will actually see on the product afterwards.
    expect(plan.matched[0].title).toBe("Sparkling Water");
  });

  it("falls back to the handle when no SKU lines up", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([
      {
        products: [
          {
            id: "gid://shopify/Product/1",
            handle: "sparkling-water",
            title: "Sparkling Water",
            skus: ["DIFFERENT-SKU"],
          },
        ],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment()],
    }));

    expect(plan.matched[0].matchedBy).toBe("handle");
    expect(plan.unmatched).toEqual([]);
  });

  it("reports products that exist in neither index", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([
      { products: [{ id: "gid://shopify/Product/1", handle: "other", title: "Other" }] },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment()],
    }));

    expect(plan.matched).toEqual([]);
    expect(plan.unmatched).toEqual([
      { handle: "sparkling-water", title: "Sparkling Water" },
    ]);
  });

  it("marks a product already carrying the right deposit as alreadyCorrect", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([
      {
        products: [
          {
            id: "gid://shopify/Product/1",
            handle: "sparkling-water",
            title: "Sparkling Water",
            skus: ["SKU-1"],
            pfand: { amount: "0.08", currency_code: "EUR" },
          },
        ],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment()],
    }));

    expect(plan.matched[0].alreadyCorrect).toBe(true);
  });

  it("does not call a different amount or currency already correct", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([
      {
        products: [
          {
            id: "gid://shopify/Product/1",
            handle: "wrong-amount",
            title: "Wrong Amount",
            pfand: { amount: "0.15", currency_code: "EUR" },
          },
          {
            id: "gid://shopify/Product/2",
            handle: "wrong-currency",
            title: "Wrong Currency",
            pfand: { amount: "0.08", currency_code: "USD" },
          },
          {
            id: "gid://shopify/Product/3",
            handle: "no-deposit",
            title: "No Deposit",
          },
        ],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [
        assignment({ handle: "wrong-amount", skus: [] }),
        assignment({ handle: "wrong-currency", skus: [] }),
        assignment({ handle: "no-deposit", skus: [] }),
      ],
    }));

    expect(plan.matched.map((product) => product.alreadyCorrect)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("splits tiers into ones to create and ones already configured here", async () => {
    findMany.mockResolvedValue([tierRow(8), tierRow(99)]);
    const { admin } = fakeAdmin([{ products: [] }]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      tiers: [
        { amount: 8, currency: "EUR", label: "Bottle", chargeTax: false },
        { amount: 15, currency: "EUR", label: "Crate", chargeTax: false },
      ],
    }));

    expect(plan.tiersToCreate).toEqual([
      { amount: 15, currency: "EUR", label: "Crate", chargeTax: false },
    ]);
    expect(plan.tiersAlreadyPresent).toEqual([{ amount: 8, currency: "EUR" }]);
    // Import is additive: the destination's own 99-cent tier isn't touched
    // or reported for removal just because the file doesn't mention it.
    expect(plan.tiersToCreate).toHaveLength(1);
  });

  it("warns when a matched product's amount would have no tier behind it", async () => {
    // The file assigns 15 cents but only ships an 8-cent tier. Importing
    // anyway leaves the product orphaned and its carts un-checkout-able.
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([
      {
        products: [
          {
            id: "gid://shopify/Product/1",
            handle: "sparkling-water",
            title: "Sparkling Water",
            skus: ["SKU-1"],
          },
        ],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment({ amount: 15 })],
    }));

    expect(plan.missingTier).toEqual([
      {
        handle: "sparkling-water",
        title: "Sparkling Water",
        amount: 15,
        currency: "EUR",
      },
    ]);
  });

  it("stays quiet when the destination already has the tier the file omits", async () => {
    findMany.mockResolvedValue([tierRow(15)]);
    const { admin } = fakeAdmin([
      {
        products: [
          {
            id: "gid://shopify/Product/1",
            handle: "sparkling-water",
            title: "Sparkling Water",
            skus: ["SKU-1"],
          },
        ],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment({ amount: 15 })],
    }));

    expect(plan.missingTier).toEqual([]);
  });

  it("only warns about unmatched products once, not per missing tier", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([{ products: [] }]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [assignment({ amount: 15 })],
    }));

    // Nothing matched, so there's no product to orphan - the merchant
    // should see one "not found" row, not a second scary banner.
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.missingTier).toEqual([]);
  });

  it("walks every page of the destination catalogue", async () => {
    findMany.mockResolvedValue([]);
    const { admin, graphql } = fakeAdmin([
      {
        products: [{ id: "gid://shopify/Product/1", handle: "page-one", title: "One" }],
        hasNextPage: true,
      },
      {
        products: [{ id: "gid://shopify/Product/2", handle: "page-two", title: "Two" }],
      },
    ]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file({
      productAssignments: [
        assignment({ handle: "page-two", title: "Two", skus: [] }),
      ],
    }));

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(plan.matched[0].productId).toBe("gid://shopify/Product/2");
    expect(plan.destinationTruncated).toBe(false);
  });

  it("carries both truncation flags through so the UI can caveat the plan", async () => {
    findMany.mockResolvedValue([]);
    // 5000 is MIGRATION_PRODUCT_SCAN_LIMIT: the scan stops there, and
    // hasNextPage is what tells us the catalogue kept going.
    const products = Array.from({ length: 5000 }, (_, index) => ({
      id: `gid://shopify/Product/${index}`,
      handle: `product-${index}`,
      title: `Product ${index}`,
    }));
    const { admin, graphql } = fakeAdmin([{ products, hasNextPage: true }]);

    const plan = await previewMigrationImport(
      admin,
      "new.myshopify.com",
      file({ truncated: true }),
    );

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(plan.destinationTruncated).toBe(true);
    expect(plan.sourceTruncated).toBe(true);
  });

  it("passes the source shop through for the preview header", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeAdmin([{ products: [] }]);

    const plan = await previewMigrationImport(admin, "new.myshopify.com", file());

    expect(plan.sourceShop).toBe("old-store.myshopify.com");
  });
});

describe("applyMigrationImport", () => {
  interface FakeStoreOptions {
    catalogue?: CatalogueProduct[];
    /** Tiers the destination already has before the import runs. */
    tiers?: Array<ReturnType<typeof tierRow>>;
    depositProductId?: string | null;
    /** userErrors for the productSet mutation that creates a tier. */
    tierErrors?: Array<{ message: string }>;
    /** userErrors for the metafieldsSet mutation that assigns deposits. */
    assignErrors?: Array<{ message: string }>;
  }

  /**
   * A stand-in destination store: it answers every operation the import
   * reaches for, and lets created tiers accumulate in the Prisma mock the
   * way a real database would.
   *
   * The accumulation is the point. createDepositTier re-reads the tier list
   * on every call and re-sends every existing variant through productSet
   * (which treats `variants` as the complete list and deletes omissions), so
   * a fake that returned a fixed list would hide exactly the bug that
   * mechanism exists to prevent.
   */
  const fakeStore = (options: FakeStoreOptions = {}) => {
    const tiers = [...(options.tiers ?? [])];
    /** Operation names in call order, for asserting what runs before what. */
    const operations: string[] = [];
    const assignedBatches: Array<Array<Record<string, unknown>>> = [];
    const productSetVariants: Array<Array<Record<string, unknown>>> = [];
    let depositProductId = options.depositProductId ?? null;
    let variantSeq = 0;

    const shopConfigRow = () => ({
      shop: SHOP,
      depositProductId,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    findMany.mockImplementation(() =>
      prismaResult([...tiers].sort((a, b) => a.amount - b.amount)),
    );
    findShopConfig.mockImplementation(() =>
      prismaResult(depositProductId ? shopConfigRow() : null),
    );
    upsertShopConfig.mockImplementation(() => prismaResult(shopConfigRow()));
    createTierRow.mockImplementation((args) => {
      const data = args.data as {
        amount: number;
        currency: string;
        label?: string | null;
        variantId: string;
      };
      const row = tierRow(data.amount, {
        currency: data.currency,
        label: data.label ?? null,
        variantId: data.variantId,
      });
      tiers.push(row);
      return prismaResult(row);
    });

    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const variables = init?.variables ?? {};
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query migrationProducts")) {
          operations.push("scan");
          return reply({
            products: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: (options.catalogue ?? []).map(catalogueNode),
            },
          });
        }

        if (query.includes("mutation upsertDepositProduct")) {
          operations.push("createTier");
          const input = variables.input as {
            variants: Array<{ id?: string; optionValues: Array<{ name: string }> }>;
          };
          productSetVariants.push(input.variants);
          if (options.tierErrors?.length) {
            return reply({ productSet: { userErrors: options.tierErrors } });
          }
          // productSet echoes back the full variant list. Entries without an
          // id are the new ones, so that's where a fresh GID gets minted -
          // which is what createDepositTier looks up by option name.
          depositProductId ??= "gid://shopify/Product/deposit";
          return reply({
            productSet: {
              product: {
                id: depositProductId,
                variants: {
                  nodes: input.variants.map((variant) => ({
                    id:
                      variant.id ??
                      `gid://shopify/ProductVariant/new-${++variantSeq}`,
                    title: variant.optionValues[0].name,
                  })),
                },
              },
              userErrors: [],
            },
          });
        }

        if (query.includes("query shopId")) {
          return reply({ shop: { id: "gid://shopify/Shop/1" } });
        }

        if (query.includes("mutation syncDepositTiers")) {
          operations.push("syncTiers");
          return reply({ metafieldsSet: { userErrors: [] } });
        }

        if (query.includes("mutation importSetDeposits")) {
          operations.push("assign");
          assignedBatches.push(
            variables.metafields as Array<Record<string, unknown>>,
          );
          return reply({
            metafieldsSet: { userErrors: options.assignErrors ?? [] },
          });
        }

        throw new Error(`fakeStore got an unexpected operation:\n${query}`);
      },
    );

    return {
      admin: { graphql } as unknown as AdminApiContext,
      graphql,
      operations,
      assignedBatches,
      productSetVariants,
      tiers,
    };
  };

  /** A destination product that will match `assignment()` by SKU. */
  const matchingProduct = {
    id: "gid://shopify/Product/1",
    handle: "sparkling-water",
    title: "Sparkling Water",
    skus: ["SKU-1"],
  };

  it("creates only the tiers the destination is missing", async () => {
    const store = fakeStore({ tiers: [tierRow(8)] });

    const result = await applyMigrationImport(
      store.admin,
      SHOP,
      file({
        tiers: [
          { amount: 8, currency: "EUR", label: "Bottle", chargeTax: false },
          { amount: 15, currency: "EUR", label: "Crate", chargeTax: false },
        ],
      }),
    );

    expect(result.tiersCreated).toBe(1);
    expect(createTierRow).toHaveBeenCalledTimes(1);
    expect(createTierRow.mock.calls[0][0].data).toMatchObject({
      amount: 15,
      currency: "EUR",
      label: "Crate",
    });
  });

  it("re-sends every existing variant when creating the next tier", async () => {
    // productSet treats `variants` as the complete list, so the second call
    // must carry the first tier's variant by id or it gets deleted. This is
    // also why the loop is sequential rather than Promise.all.
    const store = fakeStore({});

    await applyMigrationImport(
      store.admin,
      SHOP,
      file({
        tiers: [
          { amount: 15, currency: "EUR", label: null, chargeTax: false },
          { amount: 29, currency: "EUR", label: null, chargeTax: false },
        ],
      }),
    );

    expect(store.productSetVariants).toHaveLength(2);
    expect(store.productSetVariants[0]).toHaveLength(1);

    const second = store.productSetVariants[1];
    expect(second).toHaveLength(2);
    // The already-created 15-cent variant is re-sent by id (update in
    // place); the new 29-cent one has no id yet.
    expect(second[0].id).toBe("gid://shopify/ProductVariant/new-1");
    expect(second[1].id).toBeUndefined();
    expect(second.map((variant) => variant.price)).toEqual(["0.15", "0.29"]);
  });

  it("creates every tier before assigning any deposit", async () => {
    // Assigning first would briefly point products at an amount with no
    // tier behind it - the exact state the validation function blocks
    // checkout for.
    const store = fakeStore({ catalogue: [matchingProduct] });

    await applyMigrationImport(
      store.admin,
      SHOP,
      file({ productAssignments: [assignment()] }),
    );

    expect(store.operations.indexOf("createTier")).toBeLessThan(
      store.operations.indexOf("assign"),
    );
  });

  it("writes the deposit as a decimal money metafield", async () => {
    const store = fakeStore({
      tiers: [tierRow(8)],
      catalogue: [matchingProduct],
    });

    await applyMigrationImport(
      store.admin,
      SHOP,
      file({ productAssignments: [assignment()] }),
    );

    expect(store.assignedBatches).toHaveLength(1);
    expect(store.assignedBatches[0]).toEqual([
      {
        ownerId: "gid://shopify/Product/1",
        namespace: "$app",
        key: "pfand",
        type: "money",
        // Minor units become the two-decimal string the money type wants -
        // sending 8 here would read back as eight euros.
        value: JSON.stringify({ amount: "0.08", currency_code: "EUR" }),
      },
    ]);
  });

  it("leaves products that already carry the right deposit alone", async () => {
    const store = fakeStore({
      tiers: [tierRow(8)],
      catalogue: [
        { ...matchingProduct, pfand: { amount: "0.08", currency_code: "EUR" } },
      ],
    });

    const result = await applyMigrationImport(
      store.admin,
      SHOP,
      file({ productAssignments: [assignment()] }),
    );

    expect(result).toEqual({
      tiersCreated: 0,
      productsAssigned: 0,
      productsSkipped: 1,
      unmatched: 0,
    });
    // No metafield write at all rather than a no-op one: a redundant call
    // still burns rate limit and bumps the product's updatedAt.
    expect(store.assignedBatches).toEqual([]);
  });

  it("batches metafield writes at 25 per call", async () => {
    const catalogue = Array.from({ length: 26 }, (_, index) => ({
      id: `gid://shopify/Product/${index}`,
      handle: `product-${index}`,
      title: `Product ${index}`,
    }));
    const store = fakeStore({ tiers: [tierRow(8)], catalogue });

    const result = await applyMigrationImport(
      store.admin,
      SHOP,
      file({
        productAssignments: catalogue.map((product) =>
          assignment({ handle: product.handle, title: product.title, skus: [] }),
        ),
      }),
    );

    expect(store.assignedBatches.map((batch) => batch.length)).toEqual([25, 1]);
    expect(result.productsAssigned).toBe(26);
  });

  it("sends exactly one call for a full batch", async () => {
    const catalogue = Array.from({ length: 25 }, (_, index) => ({
      id: `gid://shopify/Product/${index}`,
      handle: `product-${index}`,
      title: `Product ${index}`,
    }));
    const store = fakeStore({ tiers: [tierRow(8)], catalogue });

    await applyMigrationImport(
      store.admin,
      SHOP,
      file({
        productAssignments: catalogue.map((product) =>
          assignment({ handle: product.handle, title: product.title, skus: [] }),
        ),
      }),
    );

    expect(store.assignedBatches.map((batch) => batch.length)).toEqual([25]);
  });

  it("sends no metafield call when nothing matched", async () => {
    const store = fakeStore({ tiers: [tierRow(8)] });

    const result = await applyMigrationImport(
      store.admin,
      SHOP,
      file({ productAssignments: [assignment()] }),
    );

    expect(store.assignedBatches).toEqual([]);
    expect(result).toEqual({
      tiersCreated: 0,
      productsAssigned: 0,
      productsSkipped: 0,
      unmatched: 1,
    });
  });

  it("surfaces the reason a deposit assignment was rejected", async () => {
    const store = fakeStore({
      tiers: [tierRow(8)],
      catalogue: [matchingProduct],
      assignErrors: [{ message: "Owner does not exist" }],
    });

    await expect(
      applyMigrationImport(
        store.admin,
        SHOP,
        file({ productAssignments: [assignment()] }),
      ),
    ).rejects.toThrow("Failed to assign deposits: Owner does not exist");
  });

  it("stops before touching products when a tier can't be created", async () => {
    const store = fakeStore({
      catalogue: [matchingProduct],
      tierErrors: [{ message: "Variant limit reached" }],
    });

    await expect(
      applyMigrationImport(
        store.admin,
        SHOP,
        file({ productAssignments: [assignment()] }),
      ),
    ).rejects.toThrow("Failed to create deposit tier: Variant limit reached");

    // Better to fail with nothing assigned than to leave products pointing
    // at an amount whose tier never got made.
    expect(store.assignedBatches).toEqual([]);
  });

  it("reports the counts the completion banner reads", async () => {
    const store = fakeStore({
      catalogue: [
        matchingProduct,
        {
          id: "gid://shopify/Product/2",
          handle: "already-set",
          title: "Already Set",
          pfand: { amount: "0.08", currency_code: "EUR" },
        },
      ],
    });

    const result = await applyMigrationImport(
      store.admin,
      SHOP,
      file({
        productAssignments: [
          assignment(),
          assignment({ handle: "already-set", title: "Already Set", skus: [] }),
          assignment({ handle: "missing", title: "Missing", skus: [] }),
        ],
      }),
    );

    expect(result).toEqual({
      tiersCreated: 1,
      productsAssigned: 1,
      productsSkipped: 1,
      unmatched: 1,
    });
  });
});

describe("getMigrationExport", () => {
  /**
   * A source store to export from. Catalogue pages are replayed in order so
   * pagination is exercised rather than assumed.
   */
  const fakeSourceStore = (options: {
    pages?: Array<{ products: CatalogueProduct[]; hasNextPage?: boolean }>;
    cartTransforms?: Array<{ id: string }>;
  }) => {
    const pages = options.pages ?? [{ products: [] }];
    const cursors: Array<string | null> = [];
    let page = 0;

    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query migrationCartTransform")) {
          return reply({
            cartTransforms: { nodes: options.cartTransforms ?? [] },
          });
        }

        if (query.includes("query migrationProducts")) {
          cursors.push((init?.variables?.after as string | null) ?? null);
          const current = pages[page++];
          return reply({
            products: {
              pageInfo: {
                hasNextPage: current.hasNextPage ?? false,
                endCursor: `cursor-${page}`,
              },
              nodes: current.products.map(catalogueNode),
            },
          });
        }

        throw new Error(`fakeSourceStore got an unexpected operation:\n${query}`);
      },
    );

    return { admin: { graphql } as unknown as AdminApiContext, graphql, cursors };
  };

  it("exports tiers without any store-specific ids", async () => {
    // The whole point of the file is portability. A variantId or a row id
    // leaking in is what would make the import silently target a variant
    // that doesn't exist on the destination.
    findMany.mockResolvedValue([
      tierRow(8, { label: "Bottle", variantId: "gid://shopify/ProductVariant/99" }),
    ]);
    const { admin } = fakeSourceStore({});

    const data = await getMigrationExport(admin, "old.myshopify.com");

    expect(data.tiers).toEqual([
      { amount: 8, currency: "EUR", label: "Bottle", chargeTax: false },
    ]);
  });

  it("carries the identity fields the importer matches on", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeSourceStore({
      pages: [
        {
          products: [
            {
              id: "gid://shopify/Product/1",
              handle: "sparkling-water",
              title: "Sparkling Water",
              skus: ["SKU-1", "SKU-2"],
              pfand: { amount: "0.08", currency_code: "EUR" },
            },
          ],
        },
      ],
    });

    const data = await getMigrationExport(admin, "old.myshopify.com");

    // Handle and SKUs, no product GID - same reasoning as the tiers.
    expect(data.productAssignments).toEqual([
      {
        handle: "sparkling-water",
        title: "Sparkling Water",
        skus: ["SKU-1", "SKU-2"],
        amount: 8,
        currency: "EUR",
      },
    ]);
  });

  it("leaves out products with no deposit assigned", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeSourceStore({
      pages: [
        {
          products: [
            { id: "gid://shopify/Product/1", handle: "plain", title: "Plain" },
            {
              id: "gid://shopify/Product/2",
              handle: "with-deposit",
              title: "With Deposit",
              pfand: { amount: "0.15", currency_code: "EUR" },
            },
          ],
        },
      ],
    });

    const data = await getMigrationExport(admin, "old.myshopify.com");

    expect(data.productAssignments).toHaveLength(1);
    expect(data.productAssignments[0].handle).toBe("with-deposit");
  });

  it("converts the metafield's decimal string back to minor units", async () => {
    // The importer compares these against tier amounts, which are integers.
    // 0.29 * 100 is 28.999999999999996, so this has to round, not truncate.
    findMany.mockResolvedValue([]);
    const { admin } = fakeSourceStore({
      pages: [
        {
          products: [
            {
              id: "gid://shopify/Product/1",
              handle: "a",
              title: "A",
              pfand: { amount: "0.29", currency_code: "EUR" },
            },
            {
              id: "gid://shopify/Product/2",
              handle: "b",
              title: "B",
              pfand: { amount: "15.00", currency_code: "EUR" },
            },
          ],
        },
      ],
    });

    const data = await getMigrationExport(admin, "old.myshopify.com");

    expect(data.productAssignments.map((product) => product.amount)).toEqual([
      29, 1500,
    ]);
  });

  it("drops variants with no SKU rather than exporting nulls", async () => {
    // A null in this list would be carried into the import and matched
    // against, where it can never hit anything.
    findMany.mockResolvedValue([]);
    const { admin } = fakeSourceStore({
      pages: [
        {
          products: [
            {
              id: "gid://shopify/Product/1",
              handle: "mixed",
              title: "Mixed",
              skus: ["SKU-1", null, "SKU-2"],
              pfand: { amount: "0.08", currency_code: "EUR" },
            },
          ],
        },
      ],
    });

    const data = await getMigrationExport(admin, "old.myshopify.com");

    expect(data.productAssignments[0].skus).toEqual(["SKU-1", "SKU-2"]);
  });

  it("records whether checkout enforcement is switched on", async () => {
    findMany.mockResolvedValue([]);

    const off = await getMigrationExport(
      fakeSourceStore({}).admin,
      "old.myshopify.com",
    );
    expect(off.enforcementActive).toBe(false);

    const on = await getMigrationExport(
      fakeSourceStore({ cartTransforms: [{ id: "gid://shopify/CartTransform/1" }] })
        .admin,
      "old.myshopify.com",
    );
    expect(on.enforcementActive).toBe(true);
  });

  it("walks every catalogue page, following the cursor", async () => {
    // An export that stopped at page one would hand the client a store
    // where some deposits just don't exist.
    findMany.mockResolvedValue([]);
    const store = fakeSourceStore({
      pages: [
        {
          products: [
            {
              id: "gid://shopify/Product/1",
              handle: "page-one",
              title: "One",
              pfand: { amount: "0.08", currency_code: "EUR" },
            },
          ],
          hasNextPage: true,
        },
        {
          products: [
            {
              id: "gid://shopify/Product/2",
              handle: "page-two",
              title: "Two",
              pfand: { amount: "0.15", currency_code: "EUR" },
            },
          ],
        },
      ],
    });

    const data = await getMigrationExport(store.admin, "old.myshopify.com");

    expect(data.productAssignments.map((product) => product.handle)).toEqual([
      "page-one",
      "page-two",
    ]);
    // First page starts with no cursor, the second resumes from the first's.
    expect(store.cursors).toEqual([null, "cursor-1"]);
  });

  it("flags a catalogue too large to scan in full", async () => {
    findMany.mockResolvedValue([]);
    const store = fakeSourceStore({
      pages: [
        {
          products: Array.from({ length: 5000 }, (_, index) => ({
            id: `gid://shopify/Product/${index}`,
            handle: `product-${index}`,
            title: `Product ${index}`,
          })),
          hasNextPage: true,
        },
      ],
    });

    const data = await getMigrationExport(store.admin, "old.myshopify.com");

    expect(data.truncated).toBe(true);
    // Stopped at the limit rather than paging on forever.
    expect(store.cursors).toHaveLength(1);
  });

  it("stamps the version and source shop the importer reads", async () => {
    findMany.mockResolvedValue([]);
    const { admin } = fakeSourceStore({});

    const data = await getMigrationExport(admin, "old.myshopify.com");

    expect(data.version).toBe(1);
    expect(data.sourceShop).toBe("old.myshopify.com");
  });

  it("produces a file the importer accepts unchanged", async () => {
    // Export and import are only useful as a pair. This is the assertion
    // that fails if either side's shape drifts from the other.
    findMany.mockResolvedValue([tierRow(8, { label: "Bottle" })]);
    const { admin } = fakeSourceStore({
      pages: [
        {
          products: [
            {
              id: "gid://shopify/Product/1",
              handle: "sparkling-water",
              title: "Sparkling Water",
              skus: ["SKU-1"],
              pfand: { amount: "0.08", currency_code: "EUR" },
            },
          ],
        },
      ],
      cartTransforms: [{ id: "gid://shopify/CartTransform/1" }],
    });

    const data = await getMigrationExport(admin, "old.myshopify.com");
    const reparsed = parseMigrationExportFile(JSON.stringify(data, null, 2));

    expect(reparsed).toEqual(data);
  });
});

describe("getOnboardingStatus", () => {
  interface FakeShopOptions {
    tiers?: Array<ReturnType<typeof tierRow>>;
    /** What ShopConfig has stored, which may point at a deleted product. */
    depositProductId?: string | null;
    /** null models the stored id no longer resolving to a product. */
    product?: { id: string; title: string; variantCount: number } | null;
    pfandFieldDefined?: boolean;
    cartTransformActive?: boolean;
    plan?: { publicDisplayName: string; shopifyPlus: boolean; partnerDevelopment: boolean };
    primaryDomainUrl?: string | null;
  }

  const fakeShop = (options: FakeShopOptions = {}) => {
    findMany.mockResolvedValue(options.tiers ?? []);
    findShopConfig.mockResolvedValue(
      options.depositProductId
        ? {
            shop: SHOP,
            depositProductId: options.depositProductId,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          }
        : null,
    );

    const operations: string[] = [];
    const graphql = vi.fn(async (query: string) => {
      const reply = (data: unknown) => ({ json: async () => ({ data }) });

      if (query.includes("query onboardingPfandField")) {
        operations.push("field");
        return reply({
          metafieldDefinitions: {
            nodes: options.pfandFieldDefined ? [{ id: "gid://shopify/MetafieldDefinition/1" }] : [],
          },
        });
      }

      if (query.includes("query onboardingCartTransform")) {
        operations.push("transform");
        return reply({
          cartTransforms: {
            nodes: options.cartTransformActive ? [{ id: "gid://shopify/CartTransform/1" }] : [],
          },
        });
      }

      if (query.includes("query onboardingShop")) {
        operations.push("shop");
        return reply({
          shop: {
            myshopifyDomain: "my-store.myshopify.com",
            primaryDomain:
              options.primaryDomainUrl === null
                ? null
                : { url: options.primaryDomainUrl ?? "https://shop.example.com" },
            plan: options.plan ?? {
              publicDisplayName: "Basic",
              shopifyPlus: false,
              partnerDevelopment: false,
            },
          },
        });
      }

      if (query.includes("query onboardingDepositProduct")) {
        operations.push("product");
        const product = options.product;
        return reply({
          product: product
            ? {
                id: product.id,
                title: product.title,
                variantsCount: { count: product.variantCount },
              }
            : null,
        });
      }

      throw new Error(`fakeShop got an unexpected operation:\n${query}`);
    });

    return { admin: { graphql } as unknown as AdminApiContext, graphql, operations };
  };

  const setUpProduct = {
    id: "gid://shopify/Product/deposit",
    title: "Pfand (Deposit)",
    variantCount: 2,
  };

  it("reports a fresh store as nothing done", async () => {
    const { admin } = fakeShop();

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.depositProduct).toBeNull();
    expect(status.pfandFieldDefined).toBe(false);
    expect(status.tiers).toEqual([]);
    expect(status.cartTransformActive).toBe(false);
    expect(status.completedSteps).toBe(0);
    expect(status.totalSteps).toBe(4);
  });

  it("reports a fully configured store as done", async () => {
    const { admin } = fakeShop({
      tiers: [tierRow(8)],
      depositProductId: setUpProduct.id,
      product: setUpProduct,
      pfandFieldDefined: true,
      cartTransformActive: true,
    });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.completedSteps).toBe(4);
    expect(status.depositProduct).toEqual(setUpProduct);
  });

  it("treats a stored product id that no longer resolves as not done", async () => {
    // A merchant can delete the deposit product from the admin. The stored
    // id outlives it, so believing the id alone would leave step 1 stuck on
    // "done" for a store that has nothing.
    const { admin } = fakeShop({
      depositProductId: "gid://shopify/Product/deleted",
      product: null,
      pfandFieldDefined: true,
    });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.depositProduct).toBeNull();
    expect(status.completedSteps).toBe(1);
  });

  it("doesn't look up a product when none has ever been stored", async () => {
    const { admin, operations } = fakeShop();

    await getOnboardingStatus(admin, SHOP);

    expect(operations).not.toContain("product");
  });

  it("reports the pfand field missing when the deploy didn't land", async () => {
    // Nothing a merchant does completes this step - it comes from
    // shopify.app.toml - so querying it is the only way a partial deploy
    // becomes visible instead of silently breaking assignment.
    const { admin } = fakeShop({ pfandFieldDefined: false });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.pfandFieldDefined).toBe(false);
  });

  it("counts each step independently", async () => {
    const { admin } = fakeShop({ tiers: [tierRow(8)], cartTransformActive: true });

    const status = await getOnboardingStatus(admin, SHOP);

    // Tiers and enforcement done, product and field not.
    expect(status.completedSteps).toBe(2);
  });

  it("exposes only the tier fields the setup page renders", async () => {
    const { admin } = fakeShop({
      tiers: [tierRow(8, { label: "Bottle", variantId: "gid://shopify/ProductVariant/9" })],
    });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.tiers).toEqual([
      { id: "tier-8-EUR", amount: 8, currency: "EUR", label: "Bottle" },
    ]);
  });

  it("prefers the primary domain for the storefront link", async () => {
    const { admin } = fakeShop({ primaryDomainUrl: "https://shop.example.com" });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.shop.storefrontUrl).toBe("https://shop.example.com");
  });

  it("falls back to the myshopify domain when there's no primary one", async () => {
    // A brand new store has no primary domain yet, and a setup page that
    // linked to "undefined" would be worse than one linking somewhere dull.
    const { admin } = fakeShop({ primaryDomainUrl: null });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.shop.storefrontUrl).toBe("https://my-store.myshopify.com");
  });

  it("passes the plan through for the plan-specific guidance", async () => {
    const { admin } = fakeShop({
      plan: {
        publicDisplayName: "Shopify Plus",
        shopifyPlus: true,
        partnerDevelopment: false,
      },
    });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.shop).toMatchObject({
      plan: "Shopify Plus",
      isPlus: true,
      isDevelopment: false,
    });
  });

  it("marks a development store as such", async () => {
    const { admin } = fakeShop({
      plan: {
        publicDisplayName: "Developer Preview",
        shopifyPlus: false,
        partnerDevelopment: true,
      },
    });

    const status = await getOnboardingStatus(admin, SHOP);

    expect(status.shop.isDevelopment).toBe(true);
  });
});
