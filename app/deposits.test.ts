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
    depositTier: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    shopConfig: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import prisma from "./db.server";
import {
  applyMigrationImport,
  createDepositTier,
  detectSupportedCurrencies,
  ensureSupportedCurrencies,
  formatAmount,
  getActivitySummary,
  isDepositCartTransformActive,
  getDashboardSummary,
  getMigrationExport,
  getOnboardingStatus,
  getProductDepositDetail,
  idFromGid,
  listProductsWithDepositStatus,
  parseMigrationExportFile,
  listAllDepositTiers,
  listDepositTiers,
  previewMigrationImport,
  readSupportedCurrencies,
  resolveDepositStatus,
  setDepositTierActive,
  setProductDeposit,
  syncDepositTiersMetafield,
  type MigrationExport,
} from "./deposits.server";
import { formatRelativeTime } from "./deposits.shared";

const findMany = vi.mocked(prisma.depositTier.findMany);
const createTierRow = vi.mocked(prisma.depositTier.create);
const updateTierRows = vi.mocked(prisma.depositTier.updateMany);
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
  overrides: {
    currency?: string;
    label?: string | null;
    variantId?: string;
    active?: boolean;
  } = {},
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
    active: overrides.active ?? true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
};

/**
 * Answers `findMany` the way the real table would, honouring the
 * `where: { active: true }` that separates `listDepositTiers` from
 * `listAllDepositTiers`. A fake that ignored the filter would let a test pass
 * whichever of the two the code called, which is exactly the distinction the
 * deactivation tests exist to pin down.
 */
const tiersMatching = (
  rows: Array<ReturnType<typeof tierRow>>,
  // `unknown` rather than boolean: Prisma types `active` as boolean | BoolFilter,
  // and only the plain-boolean form is what these callers pass.
  args?: { where?: { active?: unknown } },
) => {
  const activeOnly = args?.where?.active === true;
  return [...(activeOnly ? rows.filter((row) => row.active) : rows)].sort(
    (a, b) => a.amount - b.amount,
  );
};

/**
 * A full ShopConfig row from just the fields a test cares about, in the same
 * spirit as `tierRow`. Defaults to a EUR-only shop, since that's the shape
 * every suite except the currency ones is implicitly assuming.
 */
const shopConfigRow = (
  overrides: {
    depositProductId?: string | null;
    supportedCurrencies?: string[];
  } = {},
) => ({
  shop: SHOP,
  depositProductId: overrides.depositProductId ?? null,
  supportedCurrencies: JSON.stringify(overrides.supportedCurrencies ?? ["EUR"]),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
});

/** The function id every fake uses for Pfandlock's own cart transform. */
const DEPOSIT_FUNCTION_ID = "01234567-89ab-cdef-0123-456789abcdef";

/**
 * The combined cart-transform lookup, answered as a shop would - the app's
 * registered transforms plus the functions they could point at.
 *
 * `otherAppTransform` models a registration belonging to a different function
 * than the deposit one. Shopify scopes `cartTransforms` to the calling app, so
 * this stands for a second transform Pfandlock itself might ship, not a rival
 * app's - the latter can't reach this query at all.
 */
const cartTransformReply = (options: {
  depositTransform?: boolean;
  otherAppTransform?: boolean;
  functionDeployed?: boolean;
} = {}) => ({
  cartTransforms: {
    nodes: [
      ...(options.depositTransform
        ? [
            {
              id: "gid://shopify/CartTransform/1",
              functionId: DEPOSIT_FUNCTION_ID,
            },
          ]
        : []),
      ...(options.otherAppTransform
        ? [
            {
              id: "gid://shopify/CartTransform/2",
              functionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
            },
          ]
        : []),
    ],
  },
  shopifyFunctions: {
    nodes:
      options.functionDeployed === false
        ? []
        : [{ id: DEPOSIT_FUNCTION_ID, handle: "deposit-cart-transform" }],
  },
});

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

describe("readSupportedCurrencies", () => {
  /** Puts a raw column value on record, bypassing the usual JSON writer. */
  const stored = (supportedCurrencies: string | null) => {
    findShopConfig.mockResolvedValue(
      supportedCurrencies === null
        ? null
        : { ...shopConfigRow(), supportedCurrencies },
    );
  };

  it("reads back a stored list", async () => {
    stored('["EUR","USD"]');

    await expect(readSupportedCurrencies(SHOP)).resolves.toEqual(["EUR", "USD"]);
  });

  it("treats a shop with no config row as not-yet-detected", async () => {
    stored(null);

    await expect(readSupportedCurrencies(SHOP)).resolves.toEqual([]);
  });

  it("survives a value that isn't the JSON array it should be", async () => {
    // The column is a plain string, so a hand-edited row shouldn't be able to
    // take down every page that reads it. Callers already handle "empty" as
    // "detect again", which is the right recovery here too.
    for (const bad of ["", "not json", '{"EUR":true}', "null"]) {
      stored(bad);
      await expect(readSupportedCurrencies(SHOP)).resolves.toEqual([]);
    }
  });

  it("drops entries that aren't currency codes", async () => {
    stored('["EUR",42,null,"USD"]');

    await expect(readSupportedCurrencies(SHOP)).resolves.toEqual(["EUR", "USD"]);
  });
});

describe("detectSupportedCurrencies", () => {
  /**
   * A shop answering the currency query. `presentment` is what Shopify
   * reports as enabled across the shop's markets, which is the real source
   * for "what can a buyer be charged in".
   */
  const fakeCurrencyShop = (options: {
    currencyCode?: string | null;
    presentment?: string[] | null;
  } = {}) => {
    upsertShopConfig.mockImplementation((args) =>
      prismaResult(
        shopConfigRow({
          supportedCurrencies: JSON.parse(
            (args.create as { supportedCurrencies: string }).supportedCurrencies,
          ),
        }),
      ),
    );

    const graphql = vi.fn(async (query: string) => {
      if (query.includes("query shopSupportedCurrencies")) {
        return {
          json: async () => ({
            data: {
              shop: {
                currencyCode:
                  options.currencyCode === undefined ? "EUR" : options.currencyCode,
                enabledPresentmentCurrencies: options.presentment ?? [],
              },
            },
          }),
        };
      }
      throw new Error(`fakeCurrencyShop got an unexpected operation:\n${query}`);
    });

    return { admin: { graphql } as unknown as AdminApiContext, graphql };
  };

  it("reports a single-currency shop as just that currency", async () => {
    const store = fakeCurrencyShop({ currencyCode: "EUR" });

    await expect(detectSupportedCurrencies(store.admin, SHOP)).resolves.toEqual([
      "EUR",
    ]);
  });

  it("includes every currency the shop's markets can charge in", async () => {
    const store = fakeCurrencyShop({
      currencyCode: "EUR",
      presentment: ["USD", "CHF"],
    });

    await expect(detectSupportedCurrencies(store.admin, SHOP)).resolves.toEqual([
      "EUR",
      "USD",
      "CHF",
    ]);
  });

  it("leads with the shop currency and lists it once", async () => {
    // Shopify reports the shop's own currency among the presentment ones. It
    // has to lead the list (the deposit variants are priced in it, so it's
    // the default a merchant wants) and can't appear twice, or the dropdown
    // shows a duplicate option.
    const store = fakeCurrencyShop({
      currencyCode: "EUR",
      presentment: ["USD", "EUR"],
    });

    await expect(detectSupportedCurrencies(store.admin, SHOP)).resolves.toEqual([
      "EUR",
      "USD",
    ]);
  });

  it("stores the list as JSON so later requests skip the lookup", async () => {
    const store = fakeCurrencyShop({
      currencyCode: "EUR",
      presentment: ["USD"],
    });

    await detectSupportedCurrencies(store.admin, SHOP);

    expect(upsertShopConfig).toHaveBeenCalledWith({
      where: { shop: SHOP },
      create: { shop: SHOP, supportedCurrencies: '["EUR","USD"]' },
      update: { supportedCurrencies: '["EUR","USD"]' },
    });
  });

  it("still returns the currencies when they can't be cached", async () => {
    // Caching is an optimisation; the answer came back fine. Coupling the two
    // took the tier form down on a server whose Prisma client predated the
    // supportedCurrencies column - Shopify had answered, and the page went
    // dark anyway.
    const store = fakeCurrencyShop({ currencyCode: "EUR" });
    upsertShopConfig.mockRejectedValue(
      new Error("Unknown argument `supportedCurrencies`"),
    );

    await expect(detectSupportedCurrencies(store.admin, SHOP)).resolves.toEqual([
      "EUR",
    ]);
  });

  it("refuses to guess when the shop's currency can't be read", async () => {
    // Storing a wrong list is worse than storing none: it would let a
    // merchant build tiers no product can ever match.
    const store = fakeCurrencyShop({ currencyCode: null });

    await expect(
      detectSupportedCurrencies(store.admin, SHOP),
    ).rejects.toThrow(/currency/i);
    expect(upsertShopConfig).not.toHaveBeenCalled();
  });
});

describe("ensureSupportedCurrencies", () => {
  const graphqlShouldNotRun = vi.fn(async () => {
    throw new Error("ensureSupportedCurrencies should not have called Shopify");
  });

  it("uses what's already stored without calling Shopify", async () => {
    findShopConfig.mockResolvedValue(
      shopConfigRow({ supportedCurrencies: ["EUR", "USD"] }),
    );
    const admin = { graphql: graphqlShouldNotRun } as unknown as AdminApiContext;

    await expect(ensureSupportedCurrencies(admin, SHOP)).resolves.toEqual([
      "EUR",
      "USD",
    ]);
    expect(graphqlShouldNotRun).not.toHaveBeenCalled();
  });

  it("detects for a shop that has never been looked up", async () => {
    // An install predating currency detection, or one whose afterAuth hook
    // failed - either way the answer is to go and find out, not to refuse.
    findShopConfig.mockResolvedValue(null);
    upsertShopConfig.mockResolvedValue(shopConfigRow());
    const graphql = vi.fn(async () => ({
      json: async () => ({
        data: { shop: { currencyCode: "GBP", enabledPresentmentCurrencies: [] } },
      }),
    }));
    const admin = { graphql } as unknown as AdminApiContext;

    await expect(ensureSupportedCurrencies(admin, SHOP)).resolves.toEqual(["GBP"]);
  });

  it("re-detects when a stored list is empty rather than trusting it", async () => {
    findShopConfig.mockResolvedValue(shopConfigRow({ supportedCurrencies: [] }));
    upsertShopConfig.mockResolvedValue(shopConfigRow());
    const graphql = vi.fn(async () => ({
      json: async () => ({
        data: { shop: { currencyCode: "EUR", enabledPresentmentCurrencies: [] } },
      }),
    }));
    const admin = { graphql } as unknown as AdminApiContext;

    await expect(ensureSupportedCurrencies(admin, SHOP)).resolves.toEqual(["EUR"]);
    expect(graphql).toHaveBeenCalled();
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
    /** What the destination shop can charge in. EUR-only unless varied. */
    supportedCurrencies?: string[];
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

    const configRow = () =>
      shopConfigRow({
        depositProductId,
        supportedCurrencies: options.supportedCurrencies,
      });

    findMany.mockImplementation((args) => prismaResult(tiersMatching(tiers, args)));
    findShopConfig.mockImplementation(() =>
      prismaResult(depositProductId ? configRow() : null),
    );
    upsertShopConfig.mockImplementation(() => prismaResult(configRow()));
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

        // Reached when the destination shop has no ShopConfig row yet, so
        // createDepositTier has to detect what it can charge in before
        // writing the imported tiers.
        if (query.includes("query shopSupportedCurrencies")) {
          operations.push("detectCurrencies");
          const [currencyCode, ...presentment] =
            options.supportedCurrencies ?? ["EUR"];
          return reply({
            shop: { currencyCode, enabledPresentmentCurrencies: presentment },
          });
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

  it("refuses a config whose currency the destination can't charge in", async () => {
    // Importing a EUR store's setup into a GBP-only one used to "succeed"
    // and leave every imported product orphaned - checkout blocked, with
    // nothing in the app saying why. createDepositTier's currency check
    // stops it here instead.
    const store = fakeStore({
      catalogue: [matchingProduct],
      depositProductId: "gid://shopify/Product/deposit",
      supportedCurrencies: ["GBP"],
    });

    await expect(
      applyMigrationImport(
        store.admin,
        SHOP,
        file({ productAssignments: [assignment()] }),
      ),
    ).rejects.toThrow(/EUR isn't one of this store's currencies \(GBP\)/);

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
    enforcementActive?: boolean;
  }) => {
    const pages = options.pages ?? [{ products: [] }];
    const cursors: Array<string | null> = [];
    let page = 0;

    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query depositCartTransform")) {
          return reply(
            cartTransformReply({ depositTransform: options.enforcementActive }),
          );
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
      fakeSourceStore({ enforcementActive: true }).admin,
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
      enforcementActive: true,
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
        ? shopConfigRow({ depositProductId: options.depositProductId })
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

      if (query.includes("query depositCartTransform")) {
        operations.push("transform");
        return reply(
          cartTransformReply({ depositTransform: options.cartTransformActive }),
        );
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

describe("createDepositTier", () => {
  interface VariantInput {
    id?: string;
    price: string;
    taxable: boolean;
    optionValues: Array<{ optionName: string; name: string }>;
  }

  interface ProductSetCall {
    identifier?: { id: string };
    input: {
      title: string;
      status: string;
      productOptions: Array<{ name: string; position: number; values: Array<{ name: string }> }>;
      variants: VariantInput[];
    };
  }

  /**
   * The deposit product as Shopify would hold it. productSet echoes back the
   * variant list it was given, minting ids for entries that arrived without
   * one - which is how createDepositTier learns the new variant's id.
   */
  const fakeDepositProduct = (options: {
    tiers?: Array<ReturnType<typeof tierRow>>;
    depositProductId?: string | null;
    /**
     * What the shop can charge in. Given here it's already on ShopConfig, so
     * no detection call happens; omitted, the shop has no config row yet and
     * createDepositTier detects (see the shopSupportedCurrencies branch).
     */
    supportedCurrencies?: string[];
    /** What detection returns, for the shops that have to run it. */
    detected?: string[];
    userErrors?: Array<{ message: string }>;
  } = {}) => {
    const tiers = [...(options.tiers ?? [])];
    const productSetCalls: ProductSetCall[] = [];
    const syncedMetafields: Array<Record<string, unknown>> = [];
    let depositProductId = options.depositProductId ?? null;
    let variantSeq = 0;

    findMany.mockImplementation((args) => prismaResult(tiersMatching(tiers, args)));
    findShopConfig.mockImplementation(() =>
      prismaResult(
        depositProductId || options.supportedCurrencies
          ? shopConfigRow({
              depositProductId,
              supportedCurrencies: options.supportedCurrencies,
            })
          : null,
      ),
    );
    upsertShopConfig.mockImplementation(() =>
      prismaResult(
        shopConfigRow({
          depositProductId,
          supportedCurrencies: options.supportedCurrencies,
        }),
      ),
    );
    createTierRow.mockImplementation((args) => {
      const data = args.data as {
        amount: number;
        currency: string;
        label?: string | null;
        chargeTax?: boolean;
        variantId: string;
      };
      const row = {
        ...tierRow(data.amount, {
          currency: data.currency,
          label: data.label ?? null,
          variantId: data.variantId,
        }),
        chargeTax: data.chargeTax ?? false,
      };
      tiers.push(row);
      return prismaResult(row);
    });

    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("mutation upsertDepositProduct")) {
          const call = (init?.variables ?? {}) as unknown as ProductSetCall;
          productSetCalls.push(call);

          if (options.userErrors?.length) {
            return reply({ productSet: { userErrors: options.userErrors } });
          }

          depositProductId ??= "gid://shopify/Product/deposit";
          return reply({
            productSet: {
              product: {
                id: depositProductId,
                variants: {
                  nodes: call.input.variants.map((variant) => ({
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

        if (query.includes("query shopSupportedCurrencies")) {
          const [currencyCode, ...presentment] = options.detected ?? ["EUR"];
          return reply({
            shop: { currencyCode, enabledPresentmentCurrencies: presentment },
          });
        }

        if (query.includes("mutation syncDepositTiers")) {
          syncedMetafields.push(
            ...(init?.variables?.metafields as Array<Record<string, unknown>>),
          );
          return reply({ metafieldsSet: { userErrors: [] } });
        }

        throw new Error(`fakeDepositProduct got an unexpected operation:\n${query}`);
      },
    );

    return {
      admin: { graphql } as unknown as AdminApiContext,
      graphql,
      productSetCalls,
      syncedMetafields,
      tiers,
    };
  };

  it("creates the product on first use rather than updating one", async () => {
    // Omitting `identifier` is what tells productSet to make a new product.
    // Sending one that doesn't exist yet would fail instead.
    const store = fakeDepositProduct();

    await createDepositTier(store.admin, SHOP, { amount: 8 });

    expect(store.productSetCalls[0].identifier).toBeUndefined();
    expect(store.productSetCalls[0].input).toMatchObject({
      title: "Pfand (Deposit)",
      status: "ACTIVE",
    });
  });

  it("records the new product id so later tiers update it", async () => {
    const store = fakeDepositProduct();

    await createDepositTier(store.admin, SHOP, { amount: 8 });

    // Asserted by content rather than call count: a shop with no config row
    // yet also gets one written by currency detection, and it's specifically
    // the product id that later tiers depend on.
    expect(upsertShopConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { depositProductId: "gid://shopify/Product/deposit" },
      }),
    );
  });

  it("targets the existing product instead of making a second one", async () => {
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [tierRow(8, { variantId: "gid://shopify/ProductVariant/8" })],
    });

    await createDepositTier(store.admin, SHOP, { amount: 15 });

    expect(store.productSetCalls[0].identifier).toEqual({
      id: "gid://shopify/Product/deposit",
    });
    // A second deposit product would split tiers across two products and
    // leave the Functions reading only half of them.
    expect(upsertShopConfig).not.toHaveBeenCalled();
  });

  it("re-sends every existing variant by id alongside the new one", async () => {
    // productSet treats `variants` as the complete list and deletes what's
    // missing, so anything omitted here is destroyed.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [
        tierRow(8, { variantId: "gid://shopify/ProductVariant/8" }),
        tierRow(15, { variantId: "gid://shopify/ProductVariant/15" }),
      ],
    });

    await createDepositTier(store.admin, SHOP, { amount: 29 });

    const { variants, productOptions } = store.productSetCalls[0].input;
    expect(variants.map((variant) => variant.id)).toEqual([
      "gid://shopify/ProductVariant/8",
      "gid://shopify/ProductVariant/15",
      undefined,
    ]);
    // The option value list has to grow in step, or productSet rejects a
    // variant whose option value isn't declared.
    expect(productOptions[0].values.map((value) => value.name)).toEqual([
      formatAmount(8),
      formatAmount(15),
      formatAmount(29),
    ]);
  });

  it("rejects an amount that already exists, in plain words", async () => {
    // Left to the database this surfaces as "Unique constraint failed on the
    // fields: (`shop`,`amount`,`currency`)", which names an index the merchant
    // has never heard of.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [tierRow(8)],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8 }),
    ).rejects.toThrow(`A deposit amount of ${formatAmount(8, "EUR")} already exists.`);
  });

  it("says to reactivate when the clashing amount is deactivated", async () => {
    // The unique index covers inactive rows too, so this would fail either
    // way - but "it already exists" is baffling when the merchant can't see
    // it in the active list. Point at the fix instead.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [tierRow(8, { active: false })],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8 }),
    ).rejects.toThrow(/deactivated\. Reactivate it instead/);
  });

  it("doesn't touch Shopify when the amount is a duplicate", async () => {
    // productSet would mint a variant for the amount before the database
    // refused it, leaving a priced variant on the deposit product with no
    // tier behind it.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [tierRow(8)],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8 }),
    ).rejects.toThrow();

    expect(store.productSetCalls).toEqual([]);
    expect(createTierRow).not.toHaveBeenCalled();
  });

  it("allows the same amount in a different currency", async () => {
    // `[shop, amount, currency]` is the real key - 8 EUR and 8 USD are
    // different tiers, and the duplicate check has to agree with the index.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      supportedCurrencies: ["EUR", "USD"],
      tiers: [tierRow(8)],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8, currency: "USD" }),
    ).resolves.toMatchObject({ amount: 8, currency: "USD" });
  });

  it("translates a unique-constraint race into the same plain message", async () => {
    // Two tabs submitting the same new amount: both pass the duplicate check,
    // and the database catches the second one.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
    });
    createTierRow.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8 }),
    ).rejects.toThrow(`A deposit amount of ${formatAmount(8, "EUR")} already exists.`);
  });

  it("lets an unrelated database failure through untouched", async () => {
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
    });
    createTierRow.mockRejectedValue(
      Object.assign(new Error("Connection terminated"), { code: "P1017" }),
    );

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8 }),
    ).rejects.toThrow("Connection terminated");
  });

  it("sets taxable on the variant from the tax checkbox", async () => {
    // The flag was being stored in Postgres and shown in the tier list while
    // the variant Shopify actually charges kept its default treatment.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
    });

    await createDepositTier(store.admin, SHOP, { amount: 8, chargeTax: true });

    expect(store.productSetCalls[0].input.variants[0].taxable).toBe(true);
  });

  it("leaves the deposit untaxed when the box is unticked", async () => {
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
    });

    await createDepositTier(store.admin, SHOP, { amount: 8 });

    expect(store.productSetCalls[0].input.variants[0].taxable).toBe(false);
  });

  it("preserves each existing tier's tax treatment when re-sending it", async () => {
    // productSet takes each variant entry as that variant's whole desired
    // state, so leaving `taxable` off would silently reset every existing
    // tier to Shopify's default the next time any amount was added.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [
        { ...tierRow(8, { variantId: "gid://shopify/ProductVariant/8" }), chargeTax: true },
        { ...tierRow(15, { variantId: "gid://shopify/ProductVariant/15" }), chargeTax: false },
      ],
    });

    await createDepositTier(store.admin, SHOP, { amount: 25 });

    expect(
      store.productSetCalls[0].input.variants.map((variant) => variant.taxable),
    ).toEqual([true, false, false]);
  });

  it("re-sends a deactivated tier's variant too", async () => {
    // productSet deletes any variant left out of the list. Sending only the
    // active tiers would destroy a deactivated one's variant the next time
    // anything is added - orphaning the tier for good, and breaking carts
    // that already hold that deposit line.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [
        tierRow(8, { variantId: "gid://shopify/ProductVariant/8", active: false }),
        tierRow(15, { variantId: "gid://shopify/ProductVariant/15" }),
      ],
    });

    await createDepositTier(store.admin, SHOP, { amount: 25 });

    expect(
      store.productSetCalls[0].input.variants.map((variant) => variant.id),
    ).toEqual([
      "gid://shopify/ProductVariant/8",
      "gid://shopify/ProductVariant/15",
      undefined, // the new one, which productSet mints an id for
    ]);
  });

  it("leaves a deactivated tier out of what the Functions read", async () => {
    // The variant survives on the product, but the amount stops being
    // chargeable - those two have to move independently.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [
        tierRow(8, { variantId: "gid://shopify/ProductVariant/8", active: false }),
      ],
    });

    await createDepositTier(store.admin, SHOP, { amount: 25 });

    const synced = JSON.parse(
      store.syncedMetafields[0].value as string,
    ) as Array<{ amount: number }>;
    expect(synced.map((tier) => tier.amount)).toEqual([25]);
  });

  it("prices variants as a decimal string, not minor units", async () => {
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [tierRow(8, { variantId: "gid://shopify/ProductVariant/8" })],
    });

    await createDepositTier(store.admin, SHOP, { amount: 1500 });

    expect(store.productSetCalls[0].input.variants.map((v) => v.price)).toEqual([
      "0.08",
      "15.00",
    ]);
  });

  it("names the variant option after the formatted amount", async () => {
    const store = fakeDepositProduct();

    await createDepositTier(store.admin, SHOP, { amount: 8 });

    expect(store.productSetCalls[0].input.variants[0].optionValues).toEqual([
      { optionName: "Amount", name: formatAmount(8) },
    ]);
  });

  it("stores the id of the variant productSet actually created", async () => {
    // The new variant is identified by its option name in the response.
    // Storing the wrong id would price every future cart off the wrong
    // variant, which is invisible until checkout.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      tiers: [tierRow(8, { variantId: "gid://shopify/ProductVariant/8" })],
    });

    const tier = await createDepositTier(store.admin, SHOP, { amount: 29 });

    expect(tier.variantId).toBe("gid://shopify/ProductVariant/new-1");
    expect(createTierRow.mock.calls[0][0].data).toMatchObject({
      shop: SHOP,
      amount: 29,
      variantId: "gid://shopify/ProductVariant/new-1",
    });
  });

  it("defaults currency to EUR and tax to off", async () => {
    const store = fakeDepositProduct();

    await createDepositTier(store.admin, SHOP, { amount: 8 });

    expect(createTierRow.mock.calls[0][0].data).toMatchObject({
      currency: "EUR",
      chargeTax: false,
    });
  });

  it("accepts a currency the shop actually sells in", async () => {
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      supportedCurrencies: ["EUR", "USD"],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 800, currency: "USD" }),
    ).resolves.toMatchObject({ currency: "USD" });
  });

  it("refuses a currency the shop can't charge in", async () => {
    // The whole point of the check: both Functions match a product's pfand
    // currency against tier currencies exactly, so a tier in a currency the
    // shop never sells in can only ever read as orphaned - which blocks
    // checkout for every product assigned to it.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      supportedCurrencies: ["EUR"],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 800, currency: "USD" }),
    ).rejects.toThrow(/USD isn't one of this store's currencies \(EUR\)/);
  });

  it("writes nothing at all when the currency is rejected", async () => {
    // A rejected tier that still created a variant would leave an unbacked
    // price on the deposit product for a merchant to find later.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      supportedCurrencies: ["EUR"],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 800, currency: "GBP" }),
    ).rejects.toThrow();

    expect(store.productSetCalls).toEqual([]);
    expect(createTierRow).not.toHaveBeenCalled();
    expect(store.syncedMetafields).toEqual([]);
  });

  it("detects the shop's currencies when none are on record yet", async () => {
    // First tier on a shop whose afterAuth detection never ran. Refusing
    // would leave the merchant stuck with no way to add anything.
    const store = fakeDepositProduct({ detected: ["EUR", "USD"] });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 800, currency: "USD" }),
    ).resolves.toMatchObject({ currency: "USD" });
  });

  it("rejects the default currency too when the shop doesn't use it", async () => {
    // EUR is only a fallback for callers that don't pass one - it gets no
    // special treatment on a shop that sells in something else.
    const store = fakeDepositProduct({
      depositProductId: "gid://shopify/Product/deposit",
      supportedCurrencies: ["GBP"],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 800 }),
    ).rejects.toThrow(/EUR isn't one of this store's currencies/);
  });

  it("passes an explicit currency, label and tax flag through", async () => {
    const store = fakeDepositProduct({ detected: ["EUR", "USD"] });

    await createDepositTier(store.admin, SHOP, {
      amount: 800,
      currency: "USD",
      label: "Crate",
      chargeTax: true,
    });

    expect(createTierRow.mock.calls[0][0].data).toMatchObject({
      currency: "USD",
      label: "Crate",
      chargeTax: true,
    });
    expect(store.productSetCalls[0].input.variants[0].optionValues[0].name).toBe(
      formatAmount(800, "USD"),
    );
  });

  it("mirrors the new tier onto the shop metafield the Functions read", async () => {
    // The Cart Transform and Validation functions can't reach Postgres, so
    // a tier that exists only in the DB is one they'll never charge for.
    const store = fakeDepositProduct();

    await createDepositTier(store.admin, SHOP, { amount: 8 });

    expect(store.syncedMetafields).toEqual([
      {
        ownerId: "gid://shopify/Shop/1",
        namespace: "$app",
        key: "deposit_tiers",
        type: "json",
        // Synced after the row is created, so the new tier is included.
        value: JSON.stringify([
          {
            amount: 8,
            currency: "EUR",
            variantId: "gid://shopify/ProductVariant/new-1",
          },
        ]),
      },
    ]);
  });

  it("surfaces the reason productSet refused", async () => {
    const store = fakeDepositProduct({
      userErrors: [{ message: "Option values must be unique" }],
    });

    await expect(
      createDepositTier(store.admin, SHOP, { amount: 8 }),
    ).rejects.toThrow("Failed to create deposit tier: Option values must be unique");

    // Nothing recorded locally that Shopify doesn't have.
    expect(createTierRow).not.toHaveBeenCalled();
  });
});

describe("isDepositCartTransformActive", () => {
  const fakeTransforms = (reply: ReturnType<typeof cartTransformReply>) => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("query depositCartTransform")) {
        return { json: async () => ({ data: reply }) };
      }
      throw new Error(`fakeTransforms got an unexpected operation:\n${query}`);
    });
    return { admin: { graphql } as unknown as AdminApiContext };
  };

  it("reports off when nothing is registered", async () => {
    const { admin } = fakeTransforms(cartTransformReply({}));

    await expect(isDepositCartTransformActive(admin)).resolves.toBe(false);
  });

  it("reports on when the deposit transform is registered", async () => {
    const { admin } = fakeTransforms(
      cartTransformReply({ depositTransform: true }),
    );

    await expect(isDepositCartTransformActive(admin)).resolves.toBe(true);
  });

  it("doesn't count a registration for some other function", async () => {
    // Shopify scopes `cartTransforms` to the calling app, so this stands for a
    // second transform Pfandlock itself might ship - not another app's, which
    // can't appear here at all. Matching on the function id keeps "enabled"
    // meaning the deposit one specifically.
    const { admin } = fakeTransforms(
      cartTransformReply({ otherAppTransform: true }),
    );

    await expect(isDepositCartTransformActive(admin)).resolves.toBe(false);
  });

  it("still reports on when the function can't be identified", async () => {
    // Nothing to match against - the function isn't deployed to this
    // environment. Everything in `cartTransforms` belongs to this app anyway,
    // so reporting "off" on a shop where it demonstrably runs would be worse
    // than being imprecise.
    const { admin } = fakeTransforms(
      cartTransformReply({ depositTransform: true, functionDeployed: false }),
    );

    await expect(isDepositCartTransformActive(admin)).resolves.toBe(true);
  });
});

describe("listDepositTiers vs listAllDepositTiers", () => {
  it("offers only active tiers for assigning to a product", async () => {
    // The product-assign page builds its choices from this, so a deactivated
    // amount has to stop being offered - that's what makes deactivation mean
    // anything to a merchant.
    findMany.mockImplementation((args) =>
      prismaResult(
        tiersMatching([tierRow(8, { active: false }), tierRow(15)], args),
      ),
    );

    await expect(listDepositTiers(SHOP)).resolves.toMatchObject([
      { amount: 15 },
    ]);
  });

  it("keeps deactivated tiers visible to the page that manages them", async () => {
    findMany.mockImplementation((args) =>
      prismaResult(
        tiersMatching([tierRow(8, { active: false }), tierRow(15)], args),
      ),
    );

    await expect(listAllDepositTiers(SHOP)).resolves.toMatchObject([
      { amount: 8, active: false },
      { amount: 15, active: true },
    ]);
  });

  it("orphans a product still carrying a deactivated amount", async () => {
    // The deposit lives on the product's own metafield, so deactivating a
    // tier can't unassign anything - the product keeps the amount and reads
    // as orphaned, which is what blocks it at checkout.
    const activeTiers = [{ amount: 15, currency: "EUR", label: null }];

    expect(
      resolveDepositStatus({ amount: "0.08", currencyCode: "EUR" }, activeTiers),
    ).toEqual({ state: "orphaned", amount: 8, currency: "EUR" });
  });
});

describe("setDepositTierActive", () => {
  /**
   * A shop whose tier rows respond to updateMany the way Postgres would, so
   * the metafield sync that follows sees the post-update list - which is the
   * whole point of the operation.
   */
  const fakeTierStore = (options: {
    tiers?: Array<ReturnType<typeof tierRow>>;
    syncErrors?: Array<{ message: string }>;
  } = {}) => {
    const tiers = [...(options.tiers ?? [])];
    const syncedMetafields: Array<Record<string, unknown>> = [];

    findMany.mockImplementation((args) => prismaResult(tiersMatching(tiers, args)));
    updateTierRows.mockImplementation((args) => {
      const where = args.where as { id?: string; shop?: string };
      const data = args.data as { active: boolean };
      const matched = tiers.filter(
        (tier) => tier.id === where.id && tier.shop === where.shop,
      );
      for (const tier of matched) tier.active = data.active;
      return prismaResult({ count: matched.length });
    });

    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query shopId")) {
          return reply({ shop: { id: "gid://shopify/Shop/1" } });
        }

        if (query.includes("mutation syncDepositTiers")) {
          syncedMetafields.push(
            ...(init?.variables?.metafields as Array<Record<string, unknown>>),
          );
          return reply({
            metafieldsSet: { userErrors: options.syncErrors ?? [] },
          });
        }

        throw new Error(`fakeTierStore got an unexpected operation:\n${query}`);
      },
    );

    return {
      admin: { graphql } as unknown as AdminApiContext,
      graphql,
      syncedMetafields,
      tiers,
    };
  };

  /** The amounts the Functions would see, read out of the synced metafield. */
  const syncedAmounts = (metafields: Array<Record<string, unknown>>) =>
    (JSON.parse(metafields[0].value as string) as Array<{ amount: number }>).map(
      (tier) => tier.amount,
    );

  it("marks the tier inactive", async () => {
    const store = fakeTierStore({ tiers: [tierRow(8)] });

    await setDepositTierActive(store.admin, SHOP, "tier-8-EUR", false);

    expect(updateTierRows).toHaveBeenCalledWith({
      where: { id: "tier-8-EUR", shop: SHOP },
      data: { active: false },
    });
  });

  it("takes the tier out of what the Functions read", async () => {
    // The DB flag on its own changes nothing for a buyer - the Cart Transform
    // and Validation functions only ever see the shop metafield, so this sync
    // is what actually retires the amount.
    const store = fakeTierStore({ tiers: [tierRow(8), tierRow(15)] });

    await setDepositTierActive(store.admin, SHOP, "tier-8-EUR", false);

    expect(syncedAmounts(store.syncedMetafields)).toEqual([15]);
  });

  it("puts a reactivated tier back", async () => {
    const store = fakeTierStore({
      tiers: [tierRow(8, { active: false }), tierRow(15)],
    });

    await setDepositTierActive(store.admin, SHOP, "tier-8-EUR", true);

    expect(syncedAmounts(store.syncedMetafields)).toEqual([8, 15]);
  });

  it("stops at a tier belonging to another shop", async () => {
    // Tier ids ride in on a form post, and DepositTier is one table shared by
    // every install - an id alone can't be allowed to reach across shops.
    const store = fakeTierStore({
      tiers: [{ ...tierRow(8), shop: "someone-else.myshopify.com" }],
    });

    await expect(
      setDepositTierActive(store.admin, SHOP, "tier-8-EUR", false),
    ).rejects.toThrow("That deposit amount no longer exists.");

    // Nothing changed, so nothing should have been published either.
    expect(store.syncedMetafields).toEqual([]);
  });

  it("reports a failed sync instead of quietly leaving it out of step", async () => {
    // The row is already flipped at this point. Surfacing the failure is what
    // gets the merchant to retry; swallowing it would leave the Functions
    // charging an amount the app shows as retired.
    const store = fakeTierStore({
      tiers: [tierRow(8)],
      syncErrors: [{ message: "Metafield write failed" }],
    });

    await expect(
      setDepositTierActive(store.admin, SHOP, "tier-8-EUR", false),
    ).rejects.toThrow("Metafield write failed");
  });
});

describe("syncDepositTiersMetafield", () => {
  const fakeShopMetafield = (options: {
    tiers?: Array<ReturnType<typeof tierRow>>;
    userErrors?: Array<{ message: string }>;
  } = {}) => {
    findMany.mockResolvedValue(options.tiers ?? []);

    const syncedMetafields: Array<Record<string, unknown>> = [];
    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query shopId")) {
          return reply({ shop: { id: "gid://shopify/Shop/1" } });
        }

        if (query.includes("mutation syncDepositTiers")) {
          syncedMetafields.push(
            ...(init?.variables?.metafields as Array<Record<string, unknown>>),
          );
          return reply({
            metafieldsSet: { userErrors: options.userErrors ?? [] },
          });
        }

        throw new Error(`fakeShopMetafield got an unexpected operation:\n${query}`);
      },
    );

    return { admin: { graphql } as unknown as AdminApiContext, graphql, syncedMetafields };
  };

  /** The value written, parsed back out of the metafield payload. */
  const syncedTiers = (metafields: Array<Record<string, unknown>>) =>
    JSON.parse(metafields[0].value as string);

  it("writes the amount to variant mapping the Functions need", async () => {
    const store = fakeShopMetafield({
      tiers: [tierRow(8, { variantId: "gid://shopify/ProductVariant/8" })],
    });

    await syncDepositTiersMetafield(store.admin, SHOP);

    expect(store.syncedMetafields).toEqual([
      {
        // The Shop GID from the query, not the myshopify domain.
        ownerId: "gid://shopify/Shop/1",
        namespace: "$app",
        key: "deposit_tiers",
        type: "json",
        value: JSON.stringify([
          {
            amount: 8,
            currency: "EUR",
            variantId: "gid://shopify/ProductVariant/8",
          },
        ]),
      },
    ]);
  });

  it("sends only the three fields the Functions read", async () => {
    // The sandboxed Functions parse this by shape. Labels and tax flags are
    // merchant-facing metadata that has no business crossing over.
    const store = fakeShopMetafield({
      tiers: [tierRow(8, { label: "Bottle", variantId: "gid://shopify/ProductVariant/8" })],
    });

    await syncDepositTiersMetafield(store.admin, SHOP);

    expect(Object.keys(syncedTiers(store.syncedMetafields)[0])).toEqual([
      "amount",
      "currency",
      "variantId",
    ]);
  });

  it("preserves the order the tiers came back in", async () => {
    const store = fakeShopMetafield({
      tiers: [tierRow(8), tierRow(15), tierRow(29)],
    });

    await syncDepositTiersMetafield(store.admin, SHOP);

    expect(syncedTiers(store.syncedMetafields).map((tier: { amount: number }) => tier.amount)).toEqual([
      8, 15, 29,
    ]);
  });

  it("writes an empty list rather than skipping the sync", async () => {
    // If the last tier is removed, the metafield has to be emptied. Leaving
    // the previous value behind would keep the Functions charging for tiers
    // the merchant has deleted.
    const store = fakeShopMetafield({ tiers: [] });

    await syncDepositTiersMetafield(store.admin, SHOP);

    expect(store.syncedMetafields).toHaveLength(1);
    expect(syncedTiers(store.syncedMetafields)).toEqual([]);
  });

  it("reads only active tiers, cheapest first", async () => {
    // A soft-disabled tier leaking into this metafield is a tier the
    // Functions would go on charging for after the merchant retired it.
    const store = fakeShopMetafield();

    await syncDepositTiersMetafield(store.admin, SHOP);

    expect(findMany).toHaveBeenCalledWith({
      where: { shop: SHOP, active: true },
      orderBy: { amount: "asc" },
    });
  });

  it("surfaces the reason the metafield was rejected", async () => {
    const store = fakeShopMetafield({
      tiers: [tierRow(8)],
      userErrors: [{ message: "Value is invalid JSON" }],
    });

    await expect(syncDepositTiersMetafield(store.admin, SHOP)).rejects.toThrow(
      "Failed to sync deposit tiers metafield: Value is invalid JSON",
    );
  });

  it("reports every rejection, not just the first", async () => {
    const store = fakeShopMetafield({
      tiers: [tierRow(8)],
      userErrors: [{ message: "Owner does not exist" }, { message: "Type mismatch" }],
    });

    await expect(syncDepositTiersMetafield(store.admin, SHOP)).rejects.toThrow(
      "Failed to sync deposit tiers metafield: Owner does not exist, Type mismatch",
    );
  });
});

describe("setProductDeposit", () => {
  const PRODUCT = "gid://shopify/Product/1";

  const fakeProductMetafield = (options: {
    setErrors?: Array<{ message: string }>;
    deleteErrors?: Array<{ message: string }>;
  } = {}) => {
    const operations: string[] = [];
    const setPayloads: Array<Record<string, unknown>> = [];
    const deletePayloads: Array<Record<string, unknown>> = [];

    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });
        const metafields = (init?.variables?.metafields ?? []) as Array<
          Record<string, unknown>
        >;

        if (query.includes("mutation setDeposit")) {
          operations.push("set");
          setPayloads.push(...metafields);
          return reply({
            metafieldsSet: { userErrors: options.setErrors ?? [] },
          });
        }

        if (query.includes("mutation clearDeposit")) {
          operations.push("delete");
          deletePayloads.push(...metafields);
          return reply({
            metafieldsDelete: { userErrors: options.deleteErrors ?? [] },
          });
        }

        throw new Error(`fakeProductMetafield got an unexpected operation:\n${query}`);
      },
    );

    return {
      admin: { graphql } as unknown as AdminApiContext,
      graphql,
      operations,
      setPayloads,
      deletePayloads,
    };
  };

  it("writes the deposit as a money metafield on the product", async () => {
    const store = fakeProductMetafield();

    await setProductDeposit(store.admin, PRODUCT, { amount: 8, currency: "EUR" });

    expect(store.setPayloads).toEqual([
      {
        ownerId: PRODUCT,
        namespace: "$app",
        key: "pfand",
        type: "money",
        value: JSON.stringify({ amount: "0.08", currency_code: "EUR" }),
      },
    ]);
  });

  it("converts minor units to the decimal string the money type wants", async () => {
    const store = fakeProductMetafield();

    await setProductDeposit(store.admin, PRODUCT, { amount: 1500, currency: "EUR" });

    expect(JSON.parse(store.setPayloads[0].value as string).amount).toBe("15.00");
  });

  it("keeps the tier's own currency", async () => {
    const store = fakeProductMetafield();

    await setProductDeposit(store.admin, PRODUCT, { amount: 800, currency: "USD" });

    expect(JSON.parse(store.setPayloads[0].value as string)).toEqual({
      amount: "8.00",
      currency_code: "USD",
    });
  });

  it("deletes the metafield to clear a deposit rather than zeroing it", async () => {
    // "No deposit" and "a deposit of zero" are different states: a zero
    // would still read as an assignment, and resolveDepositStatus would
    // report it orphaned against a tier list that has no 0 amount.
    const store = fakeProductMetafield();

    await setProductDeposit(store.admin, PRODUCT, null);

    expect(store.operations).toEqual(["delete"]);
    expect(store.deletePayloads).toEqual([
      { ownerId: PRODUCT, namespace: "$app", key: "pfand" },
    ]);
  });

  it("surfaces why a deposit couldn't be assigned", async () => {
    const store = fakeProductMetafield({
      setErrors: [{ message: "Owner does not exist" }],
    });

    await expect(
      setProductDeposit(store.admin, PRODUCT, { amount: 8, currency: "EUR" }),
    ).rejects.toThrow("Owner does not exist");
  });

  it("surfaces why a deposit couldn't be cleared", async () => {
    const store = fakeProductMetafield({
      deleteErrors: [{ message: "Metafield does not exist" }],
    });

    await expect(setProductDeposit(store.admin, PRODUCT, null)).rejects.toThrow(
      "Metafield does not exist",
    );
  });

  it("reports every rejection, not just the first", async () => {
    const store = fakeProductMetafield({
      setErrors: [{ message: "Owner does not exist" }, { message: "Type mismatch" }],
    });

    await expect(
      setProductDeposit(store.admin, PRODUCT, { amount: 8, currency: "EUR" }),
    ).rejects.toThrow("Owner does not exist, Type mismatch");
  });
});

describe("getDashboardSummary", () => {
  interface DashboardProduct {
    id: string;
    title: string;
    pfand?: { amount: string; currency_code: string } | null;
  }

  /** One product as the dashboard's product query returns it. */
  const dashboardNode = (product: DashboardProduct) => ({
    id: product.id,
    title: product.title,
    productType: "Drinks",
    featuredMedia: null,
    variantsCount: { count: 1 },
    priceRangeV2: { minVariantPrice: { amount: "1.99", currencyCode: "EUR" } },
    pfand: product.pfand ? { jsonValue: product.pfand } : null,
  });

  const fakeDashboard = (options: {
    tiers?: Array<ReturnType<typeof tierRow>>;
    products?: DashboardProduct[];
    /** Catalogue size, which can far exceed the page actually scanned. */
    totalProductCount?: number;
    cartTransformActive?: boolean;
  } = {}) => {
    findMany.mockResolvedValue(options.tiers ?? []);

    const productQueryVariables: Array<Record<string, unknown>> = [];
    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query dashboardProductsCount")) {
          return reply({
            productsCount: { count: options.totalProductCount ?? 0 },
          });
        }

        if (query.includes("query depositCartTransform")) {
          return reply(
            cartTransformReply({ depositTransform: options.cartTransformActive }),
          );
        }

        if (query.includes("query productsWithDeposit")) {
          productQueryVariables.push(init?.variables ?? {});
          return reply({
            products: { nodes: (options.products ?? []).map(dashboardNode) },
          });
        }

        throw new Error(`fakeDashboard got an unexpected operation:\n${query}`);
      },
    );

    return {
      admin: { graphql } as unknown as AdminApiContext,
      graphql,
      productQueryVariables,
    };
  };

  const eur = (amount: string) => ({ amount, currency_code: "EUR" });

  it("counts how many products sit on each tier", async () => {
    const store = fakeDashboard({
      tiers: [tierRow(8), tierRow(15)],
      products: [
        { id: "gid://shopify/Product/1", title: "A", pfand: eur("0.08") },
        { id: "gid://shopify/Product/2", title: "B", pfand: eur("0.08") },
        { id: "gid://shopify/Product/3", title: "C", pfand: eur("0.15") },
      ],
    });

    const summary = await getDashboardSummary(store.admin, SHOP);

    expect(summary.tiers).toEqual([
      { id: "tier-8-EUR", amount: 8, currency: "EUR", label: null, productCount: 2 },
      { id: "tier-15-EUR", amount: 15, currency: "EUR", label: null, productCount: 1 },
    ]);
    expect(summary.attachingCount).toBe(3);
  });

  it("shows a tier nobody uses as zero rather than omitting it", async () => {
    // A tier with no products is exactly what a merchant needs to see.
    const store = fakeDashboard({ tiers: [tierRow(8)] });

    const summary = await getDashboardSummary(store.admin, SHOP);

    expect(summary.tiers).toHaveLength(1);
    expect(summary.tiers[0].productCount).toBe(0);
    expect(summary.attachingCount).toBe(0);
  });

  it("keys tier counts by currency as well as amount", async () => {
    // An 8 USD product must not be counted against the 8 EUR tier.
    const store = fakeDashboard({
      tiers: [tierRow(8)],
      products: [
        { id: "gid://shopify/Product/1", title: "Euro", pfand: eur("0.08") },
        {
          id: "gid://shopify/Product/2",
          title: "Dollar",
          pfand: { amount: "0.08", currency_code: "USD" },
        },
      ],
    });

    const summary = await getDashboardSummary(store.admin, SHOP);

    expect(summary.tiers[0].productCount).toBe(1);
    // The dollar one has no matching tier, so it's orphaned, not attaching.
    expect(summary.attachingCount).toBe(1);
    expect(summary.orphanedProducts).toEqual([
      {
        id: "gid://shopify/Product/2",
        title: "Dollar",
        amount: 8,
        currency: "USD",
      },
    ]);
  });

  it("lists products tagged with an amount no tier backs", async () => {
    // These are the ones that block checkout, so the dashboard names them
    // rather than just counting them.
    const store = fakeDashboard({
      tiers: [tierRow(8)],
      products: [
        { id: "gid://shopify/Product/1", title: "Orphan", pfand: eur("0.25") },
      ],
    });

    const summary = await getDashboardSummary(store.admin, SHOP);

    expect(summary.orphanedProducts).toEqual([
      {
        id: "gid://shopify/Product/1",
        title: "Orphan",
        amount: 25,
        currency: "EUR",
      },
    ]);
    expect(summary.attachingCount).toBe(0);
  });

  it("ignores products with no deposit in either count", async () => {
    const store = fakeDashboard({
      tiers: [tierRow(8)],
      products: [
        { id: "gid://shopify/Product/1", title: "Plain" },
        { id: "gid://shopify/Product/2", title: "Deposited", pfand: eur("0.08") },
      ],
    });

    const summary = await getDashboardSummary(store.admin, SHOP);

    expect(summary.attachingCount).toBe(1);
    expect(summary.orphanedProducts).toEqual([]);
  });

  it("takes the catalogue total from the count query, not the scanned page", async () => {
    // Coverage is measured from one page of 250, but "how many products do
    // I have" has to be the real number or the dashboard understates the
    // work left to do.
    const store = fakeDashboard({
      tiers: [tierRow(8)],
      products: [
        { id: "gid://shopify/Product/1", title: "A", pfand: eur("0.08") },
      ],
      totalProductCount: 1000,
    });

    const summary = await getDashboardSummary(store.admin, SHOP);

    expect(summary.totalProductCount).toBe(1000);
    expect(summary.attachingCount).toBe(1);
  });

  it("scans a full page of products for the coverage breakdown", async () => {
    const store = fakeDashboard();

    await getDashboardSummary(store.admin, SHOP);

    expect(store.productQueryVariables).toEqual([{ first: 250 }]);
  });

  it("reports whether checkout enforcement is on", async () => {
    const off = await getDashboardSummary(fakeDashboard().admin, SHOP);
    expect(off.cartTransformActive).toBe(false);

    const on = await getDashboardSummary(
      fakeDashboard({ cartTransformActive: true }).admin,
      SHOP,
    );
    expect(on.cartTransformActive).toBe(true);
  });
});

describe("getActivitySummary", () => {
  const at = (iso: string) => new Date(iso);

  /** A tier row with explicit timestamps, which is all this reads. */
  const timedTier = (
    amount: number,
    createdAt: string,
    updatedAt: string = createdAt,
    overrides: { currency?: string; label?: string | null } = {},
  ) => ({
    ...tierRow(amount, overrides),
    createdAt: at(createdAt),
    updatedAt: at(updatedAt),
  });

  it("reads a tier whose timestamps match as newly added", async () => {
    findMany.mockResolvedValue([timedTier(8, "2026-03-01T10:00:00Z")]);

    const summary = await getActivitySummary(SHOP);

    expect(summary.events).toEqual([
      {
        id: "tier-8-EUR",
        message: `${formatAmount(8)} amount added`,
        detail: null,
        when: at("2026-03-01T10:00:00Z"),
      },
    ]);
  });

  it("reads a tier edited after creation as updated", async () => {
    // createdAt vs updatedAt is the only thing distinguishing the two, so
    // an equality check that drifted to `>=` would relabel every new tier.
    findMany.mockResolvedValue([
      timedTier(15, "2026-03-01T10:00:00Z", "2026-03-05T09:00:00Z"),
    ]);

    const summary = await getActivitySummary(SHOP);

    expect(summary.events[0].message).toBe(`${formatAmount(15)} amount updated`);
    // The edit is the event, so it's dated by the edit.
    expect(summary.events[0].when).toEqual(at("2026-03-05T09:00:00Z"));
  });

  it("orders events newest first", async () => {
    findMany.mockResolvedValue([
      timedTier(8, "2026-03-01T10:00:00Z"),
      timedTier(29, "2026-03-09T10:00:00Z"),
      timedTier(15, "2026-03-01T09:00:00Z", "2026-03-05T09:00:00Z"),
    ]);

    const summary = await getActivitySummary(SHOP);

    // Sorted on the event date, so the edited 15 sits above the older 8
    // despite having been created first.
    expect(summary.events.map((event) => event.when)).toEqual([
      at("2026-03-09T10:00:00Z"),
      at("2026-03-05T09:00:00Z"),
      at("2026-03-01T10:00:00Z"),
    ]);
  });

  it("uses the tier label as the event detail", async () => {
    findMany.mockResolvedValue([
      timedTier(8, "2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z", {
        label: "Single-use bottle",
      }),
    ]);

    const summary = await getActivitySummary(SHOP);

    expect(summary.events[0].detail).toBe("Single-use bottle");
  });

  it("formats the amount in the tier's own currency", async () => {
    findMany.mockResolvedValue([
      timedTier(800, "2026-03-01T10:00:00Z", "2026-03-01T10:00:00Z", {
        currency: "USD",
      }),
    ]);

    const summary = await getActivitySummary(SHOP);

    expect(summary.events[0].message).toBe(`${formatAmount(800, "USD")} amount added`);
  });

  it("keeps retired tiers in the history", async () => {
    // Unlike listDepositTiers, this deliberately doesn't filter on active.
    // Soft-deleting a tier shouldn't erase the record that it once existed
    // - that's the whole point of soft-deleting it.
    findMany.mockResolvedValue([]);

    await getActivitySummary(SHOP);

    expect(findMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
  });

  it("counts the config changes it found", async () => {
    findMany.mockResolvedValue([
      timedTier(8, "2026-03-01T10:00:00Z"),
      timedTier(15, "2026-03-02T10:00:00Z"),
    ]);

    const summary = await getActivitySummary(SHOP);

    expect(summary.configChangeCount).toBe(2);
  });

  it("reports nothing rather than failing on a store with no tiers", async () => {
    findMany.mockResolvedValue([]);

    const summary = await getActivitySummary(SHOP);

    expect(summary).toEqual({ events: [], configChangeCount: 0 });
  });
});

describe("getProductDepositDetail", () => {
  const PRODUCT = "gid://shopify/Product/1";

  const fakeProduct = (options: {
    tiers?: Array<ReturnType<typeof tierRow>>;
    product?: {
      title?: string;
      vendor?: string;
      variantCount?: number;
      pfand?: { amount: string; currency_code: string } | null;
    } | null;
  } = {}) => {
    findMany.mockResolvedValue(options.tiers ?? []);

    const queryVariables: Array<Record<string, unknown>> = [];
    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        const reply = (data: unknown) => ({ json: async () => ({ data }) });

        if (query.includes("query productDepositDetail")) {
          queryVariables.push(init?.variables ?? {});
          // `product: null` is what Shopify returns for an id that no
          // longer resolves, not an error.
          if (options.product === null) return reply({ product: null });

          const product = options.product ?? {};
          return reply({
            product: {
              id: PRODUCT,
              title: product.title ?? "Sparkling Water",
              vendor: product.vendor ?? "Acme",
              variantsCount: { count: product.variantCount ?? 3 },
              pfand: product.pfand ? { jsonValue: product.pfand } : null,
            },
          });
        }

        throw new Error(`fakeProduct got an unexpected operation:\n${query}`);
      },
    );

    return { admin: { graphql } as unknown as AdminApiContext, graphql, queryVariables };
  };

  it("returns the product's basic details", async () => {
    const store = fakeProduct({
      product: { title: "Sparkling Water", vendor: "Acme", variantCount: 3 },
    });

    const detail = await getProductDepositDetail(store.admin, SHOP, PRODUCT);

    expect(detail).toEqual({
      id: PRODUCT,
      title: "Sparkling Water",
      vendor: "Acme",
      totalVariants: 3,
      status: { state: "no-deposit" },
    });
    expect(store.queryVariables).toEqual([{ id: PRODUCT }]);
  });

  it("returns null for a product that no longer exists", async () => {
    // The assign page is reachable by URL, so a deleted product has to come
    // back as "not found" rather than throwing on a null.
    const store = fakeProduct({ product: null });

    const detail = await getProductDepositDetail(store.admin, SHOP, PRODUCT);

    expect(detail).toBeNull();
  });

  it("resolves a deposit that has a matching tier", async () => {
    const store = fakeProduct({
      tiers: [tierRow(8, { label: "Bottle" })],
      product: { pfand: { amount: "0.08", currency_code: "EUR" } },
    });

    const detail = await getProductDepositDetail(store.admin, SHOP, PRODUCT);

    expect(detail?.status).toEqual({
      state: "attaching",
      tier: expect.objectContaining({ amount: 8, currency: "EUR", label: "Bottle" }),
    });
  });

  it("translates the metafield's currency_code before matching", async () => {
    // The money metafield uses snake_case; resolveDepositStatus expects
    // currencyCode. Passing it through unmapped would leave the currency
    // undefined and read every assigned deposit as orphaned.
    const store = fakeProduct({
      tiers: [tierRow(800, { currency: "USD" })],
      product: { pfand: { amount: "8.00", currency_code: "USD" } },
    });

    const detail = await getProductDepositDetail(store.admin, SHOP, PRODUCT);

    expect(detail?.status.state).toBe("attaching");
  });

  it("flags a deposit with no backing tier as orphaned", async () => {
    const store = fakeProduct({
      tiers: [tierRow(8)],
      product: { pfand: { amount: "0.25", currency_code: "EUR" } },
    });

    const detail = await getProductDepositDetail(store.admin, SHOP, PRODUCT);

    expect(detail?.status).toEqual({
      state: "orphaned",
      amount: 25,
      currency: "EUR",
    });
  });

  it("reports no deposit when the metafield is unset", async () => {
    const store = fakeProduct({ tiers: [tierRow(8)], product: {} });

    const detail = await getProductDepositDetail(store.admin, SHOP, PRODUCT);

    expect(detail?.status).toEqual({ state: "no-deposit" });
  });
});

describe("listProductsWithDepositStatus", () => {
  interface ListedProduct {
    id?: string;
    title?: string;
    productType?: string;
    variantCount?: number;
    /** Left undefined for a product with no image at all. */
    featuredMedia?: { preview?: { image?: { url: string } } } | null;
    price?: { amount: string; currencyCode: string };
    pfand?: { amount: string; currency_code: string } | null;
  }

  const fakeCatalogue = (options: {
    tiers?: Array<ReturnType<typeof tierRow>>;
    products?: ListedProduct[];
  } = {}) => {
    findMany.mockResolvedValue(options.tiers ?? []);

    const queryVariables: Array<Record<string, unknown>> = [];
    const graphql = vi.fn(
      async (query: string, init?: { variables?: Record<string, unknown> }) => {
        if (!query.includes("query productsWithDeposit")) {
          throw new Error(`fakeCatalogue got an unexpected operation:\n${query}`);
        }
        queryVariables.push(init?.variables ?? {});

        return {
          json: async () => ({
            data: {
              products: {
                nodes: (options.products ?? []).map((product, index) => ({
                  id: product.id ?? `gid://shopify/Product/${index + 1}`,
                  title: product.title ?? `Product ${index + 1}`,
                  productType: product.productType ?? "Drinks",
                  featuredMedia: product.featuredMedia ?? null,
                  variantsCount: { count: product.variantCount ?? 1 },
                  priceRangeV2: {
                    minVariantPrice: product.price ?? {
                      amount: "1.99",
                      currencyCode: "EUR",
                    },
                  },
                  pfand: product.pfand ? { jsonValue: product.pfand } : null,
                })),
              },
            },
          }),
        };
      },
    );

    return { admin: { graphql } as unknown as AdminApiContext, graphql, queryVariables };
  };

  it("asks for a page of 25 by default", async () => {
    const store = fakeCatalogue();

    await listProductsWithDepositStatus(store.admin, SHOP);

    expect(store.queryVariables).toEqual([{ first: 25 }]);
  });

  it("honours an explicit page size", async () => {
    // The dashboard asks for 250; the list page takes the default.
    const store = fakeCatalogue();

    await listProductsWithDepositStatus(store.admin, SHOP, { first: 250 });

    expect(store.queryVariables).toEqual([{ first: 250 }]);
  });

  it("maps the fields the product list renders", async () => {
    const store = fakeCatalogue({
      products: [
        {
          id: "gid://shopify/Product/1",
          title: "Sparkling Water",
          productType: "Drinks",
          variantCount: 4,
          featuredMedia: { preview: { image: { url: "https://cdn/water.jpg" } } },
          price: { amount: "1.99", currencyCode: "EUR" },
        },
      ],
    });

    const products = await listProductsWithDepositStatus(store.admin, SHOP);

    expect(products).toEqual([
      {
        id: "gid://shopify/Product/1",
        title: "Sparkling Water",
        productType: "Drinks",
        totalVariants: 4,
        imageUrl: "https://cdn/water.jpg",
        price: "1.99",
        currencyCode: "EUR",
        status: { state: "no-deposit" },
      },
    ]);
  });

  it("keeps the product price as the decimal string Shopify sent", async () => {
    // Everything else in this module is minor units, so converting this one
    // too would be an easy mistake - but it's the product's own price,
    // rendered straight, not an amount we ever compare against a tier.
    const store = fakeCatalogue({
      products: [{ price: { amount: "12.50", currencyCode: "EUR" } }],
    });

    const products = await listProductsWithDepositStatus(store.admin, SHOP);

    expect(products[0].price).toBe("12.50");
  });

  it("falls back to no image at each level of the media chain", async () => {
    // featuredMedia, its preview and that preview's image are each
    // independently absent in real responses.
    const store = fakeCatalogue({
      products: [
        { featuredMedia: null },
        { featuredMedia: {} },
        { featuredMedia: { preview: {} } },
        { featuredMedia: { preview: { image: { url: "https://cdn/ok.jpg" } } } },
      ],
    });

    const products = await listProductsWithDepositStatus(store.admin, SHOP);

    expect(products.map((product) => product.imageUrl)).toEqual([
      null,
      null,
      null,
      "https://cdn/ok.jpg",
    ]);
  });

  it("resolves each product's deposit status against the shop's tiers", async () => {
    const store = fakeCatalogue({
      tiers: [tierRow(8, { label: "Bottle" })],
      products: [
        { pfand: { amount: "0.08", currency_code: "EUR" } },
        { pfand: { amount: "0.25", currency_code: "EUR" } },
        {},
      ],
    });

    const products = await listProductsWithDepositStatus(store.admin, SHOP);

    expect(products.map((product) => product.status.state)).toEqual([
      "attaching",
      "orphaned",
      "no-deposit",
    ]);
  });

  it("translates the metafield's currency_code before matching", async () => {
    // Same hand-written rename as the detail query, same silent failure if
    // it drifts: no tier matches and everything reads orphaned.
    const store = fakeCatalogue({
      tiers: [tierRow(800, { currency: "USD" })],
      products: [{ pfand: { amount: "8.00", currency_code: "USD" } }],
    });

    const products = await listProductsWithDepositStatus(store.admin, SHOP);

    expect(products[0].status.state).toBe("attaching");
  });

  it("returns nothing for an empty catalogue", async () => {
    const store = fakeCatalogue({ products: [] });

    expect(await listProductsWithDepositStatus(store.admin, SHOP)).toEqual([]);
  });
});
