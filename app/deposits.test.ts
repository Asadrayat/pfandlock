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
  default: { depositTier: { findMany: vi.fn() } },
}));

import prisma from "./db.server";
import {
  formatAmount,
  idFromGid,
  parseMigrationExportFile,
  previewMigrationImport,
  resolveDepositStatus,
  type MigrationExport,
} from "./deposits.server";
import { formatRelativeTime } from "./deposits.shared";

const findMany = vi.mocked(prisma.depositTier.findMany);

beforeEach(() => {
  vi.clearAllMocks();
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
  interface FakeProduct {
    id: string;
    handle: string;
    title: string;
    skus?: string[];
    pfand?: { amount: string; currency_code: string } | null;
  }

  const node = (product: FakeProduct) => ({
    id: product.id,
    handle: product.handle,
    title: product.title,
    pfand: product.pfand ? { jsonValue: product.pfand } : null,
    variants: { nodes: (product.skus ?? []).map((sku) => ({ sku })) },
  });

  /** An admin client that replays fixed catalogue pages, one per call. */
  const fakeAdmin = (pages: Array<{ products: FakeProduct[]; hasNextPage?: boolean }>) => {
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
              nodes: page.products.map(node),
            },
          },
        }),
      };
    });
    return { admin: { graphql } as unknown as AdminApiContext, graphql };
  };

  const file = (overrides: Partial<MigrationExport> = {}): MigrationExport => ({
    version: 1,
    sourceShop: "old-store.myshopify.com",
    enforcementActive: true,
    tiers: [{ amount: 8, currency: "EUR", label: "Bottle", chargeTax: false }],
    productAssignments: [],
    truncated: false,
    ...overrides,
  });

  /**
   * A full DepositTier row from just the two fields that matter here. The
   * planner only reads amount and currency, but the mock has to satisfy
   * Prisma's real return type, and spelling the rest out at each call site
   * would bury what the test is actually varying.
   */
  const tierRow = (amount: number, currency = "EUR") => ({
    id: `tier-${amount}-${currency}`,
    shop: "new.myshopify.com",
    amount,
    currency,
    label: null,
    variantId: `gid://shopify/ProductVariant/${amount}`,
    chargeTax: false,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });

  const assignment = (overrides: Partial<MigrationExport["productAssignments"][number]> = {}) => ({
    handle: "sparkling-water",
    title: "Sparkling Water",
    skus: ["SKU-1"],
    amount: 8,
    currency: "EUR",
    ...overrides,
  });

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
