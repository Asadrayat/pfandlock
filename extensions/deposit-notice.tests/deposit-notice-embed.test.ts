// Contract tests for the global "Pfandlock deposit notice" app embed - the
// deposit-notice-embed.liquid counterpart to deposit-notice.liquid. See that
// file's test for why these are regex/JSON assertions rather than rendered
// output: liquidjs doesn't implement Shopify's `money` filter or metafield
// drops, and everything here fails *silently* on the storefront rather than
// erroring, so an assertion is the only thing that would catch a regression.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, "..", "deposit-notice");
const repoRoot = path.resolve(extensionDir, "..", "..");

const liquid = fs.readFileSync(
  path.join(extensionDir, "blocks", "deposit-notice-embed.liquid"),
  "utf8",
);
const liquidCode = liquid.replace(
  /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
  "",
);
const locale = JSON.parse(
  fs.readFileSync(path.join(extensionDir, "locales", "en.default.json"), "utf8"),
);
const appToml = fs.readFileSync(path.join(repoRoot, "shopify.app.toml"), "utf8");

const lookup = (key: string) =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      locale,
    );

describe("deposit notice embed block", () => {
  it("reads a metafield the app actually declares, through the $app prefix", () => {
    const used = liquidCode.match(/metafields\["\$app"\]\.(\w+)/);
    expect(used, "block must read the metafield via the $app prefix").not.toBeNull();

    const [, key] = used!;
    expect(appToml).toContain(`[product.metafields.app.${key}]`);
  });

  it("never reaches for a metafield namespace with dot syntax", () => {
    expect(liquidCode).not.toMatch(/metafields\.\w+\.\w+/);
  });

  it("ships every translation key it uses", () => {
    const keys = [...liquid.matchAll(/'([\w.]+)'\s*\|\s*t\b/g)].map((match) => match[1]);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(typeof lookup(key), `missing translation for '${key}'`).toBe("string");
    }
  });

  it("passes exactly the variables its translation interpolates", () => {
    const call = liquid.match(/'([\w.]+)'\s*\|\s*t:\s*([^%}]+)/);
    expect(call).not.toBeNull();

    const [, key, args] = call!;
    const passed = [...args.matchAll(/(\w+):/g)].map((match) => match[1]).sort();
    const translation = lookup(key) as string;
    const interpolated = [...translation.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
      .map((match) => match[1])
      .sort();

    expect(passed).toEqual(interpolated);
  });

  it("keeps the schema valid JSON, targeting body as an app embed", () => {
    // An app embed's `target` has to be "head", "compliance_head", or
    // "body" - "section" (what deposit-notice.liquid uses) makes it a
    // manually-added app block instead, and it wouldn't show up in the
    // theme editor's App embeds panel at all.
    const schema = JSON.parse(
      liquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/)![1],
    );

    expect(schema.name).toBeTruthy();
    expect(["head", "compliance_head", "body"]).toContain(schema.target);
  });

  it("restricts itself to the product template", () => {
    // Without this, Shopify renders (and this block's own `product` guard
    // silently no-ops on) every other page on the storefront too.
    const schema = JSON.parse(
      liquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/)![1],
    );

    expect(schema.enabled_on?.templates).toContain("product");
  });

  it("guards on both `product` and the metafield before rendering anything", () => {
    // `product` first: an app embed's Liquid runs on every storefront page,
    // not just product pages, so without this guard `product.metafields`
    // would throw (or worse, silently resolve against the wrong page) on
    // the pages this embed isn't meant for.
    expect(liquid).toMatch(/\{%\s*if\s+product\s*%\}/);
    expect(liquid).toMatch(/\{%\s*if\s+pfand\.value\s*%\}/);
  });

  it("formats the amount through a money filter", () => {
    expect(liquid).toMatch(/\|\s*money\b/);
  });

  it("loads its positioning script and stylesheet from the assets directory", () => {
    // Theme app extensions only serve files from assets/ - a typo here
    // 404s silently, and the notice renders hidden forever.
    const scriptMatch = liquid.match(/'([\w.-]+\.js)'\s*\|\s*asset_url/);
    const styleMatch = liquid.match(/'([\w.-]+\.css)'\s*\|\s*asset_url/);
    expect(scriptMatch).not.toBeNull();
    expect(styleMatch).not.toBeNull();

    expect(
      fs.existsSync(path.join(extensionDir, "assets", scriptMatch![1])),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(extensionDir, "assets", styleMatch![1])),
    ).toBe(true);
  });

  it("renders hidden until the positioning script decides where it goes", () => {
    // Otherwise the notice flashes at the very bottom of the page (an app
    // embed's fixed injection point) before the script moves it.
    expect(liquid).toMatch(/<p[^>]*\bhidden\b[^>]*>/);
  });
});
