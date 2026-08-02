// Contract tests for the storefront deposit notice.
//
// This block is Liquid, so there's no logic to unit test and no runtime to
// test it in - liquidjs doesn't implement Shopify's `money` filter or
// metafield drops, so rendering it here would only prove a mock works.
//
// What can break is everything it references across a boundary: the
// metafield the app declares, the translation key it ships, and the schema
// setting the theme editor fills in. Every one of those fails *silently* -
// a renamed metafield makes `{% if pfand.value %}` quietly never fire, a
// missing translation key renders blank - so none of them surface as an
// error anyone would notice. That's what these pin down.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.dirname(here);
const repoRoot = path.resolve(extensionDir, "..", "..");

const liquid = fs.readFileSync(
  path.join(extensionDir, "blocks", "deposit-notice.liquid"),
  "utf8",
);
/**
 * The block minus its {% comment %} blocks. Assertions about what the block
 * *doesn't* do need this - the comments explain the wrong forms by name, so
 * matching against the raw file would flag the explanation as the mistake.
 */
const liquidCode = liquid.replace(
  /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
  "",
);
const locale = JSON.parse(
  fs.readFileSync(path.join(extensionDir, "locales", "en.default.json"), "utf8"),
);
const appToml = fs.readFileSync(path.join(repoRoot, "shopify.app.toml"), "utf8");

/** Looks up a dotted key like "deposit_notice.text" in the locale file. */
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

describe("deposit notice block", () => {
  it("reads a metafield the app actually declares, through the $app prefix", () => {
    // shopify.app.toml's [product.metafields.app.<key>] creates the field
    // under namespace "$app", and the reserved prefix is only reachable via
    // the bracket form. Dot syntax (metafields.app.<key>) asks for a literal
    // namespace named "app" and quietly resolves to nil, so this pins the
    // bracket form as much as it pins the key. Renaming either side leaves
    // the notice permanently hidden rather than erroring.
    const used = liquidCode.match(/metafields\["\$app"\]\.(\w+)/);
    expect(used, "block must read the metafield via the $app prefix").not.toBeNull();

    const [, key] = used!;
    expect(appToml).toContain(`[product.metafields.app.${key}]`);
  });

  it("never reaches for a metafield namespace with dot syntax", () => {
    // The regression this file exists for: `metafields.app.pfand` parses,
    // renders, and is wrong on every product. Nothing about it looks broken,
    // so only an assertion catches it coming back.
    expect(liquidCode).not.toMatch(/metafields\.\w+\.\w+/);
  });

  it("declares that metafield as readable from the storefront", () => {
    // Liquid can't see a metafield without storefront access, and the
    // failure mode is again an empty notice rather than an error.
    expect(appToml).toMatch(/storefront\s*=\s*"public_read"/);
  });

  it("ships every translation key it uses", () => {
    const keys = [...liquid.matchAll(/'([\w.]+)'\s*\|\s*t\b/g)].map((match) => match[1]);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(typeof lookup(key), `missing translation for '${key}'`).toBe("string");
    }
  });

  it("passes exactly the variables its translation interpolates", () => {
    // `t: amount: x` against a string containing {{ amount }}. A rename on
    // either side renders the literal placeholder to the buyer.
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

  it("only reads settings its schema defines", () => {
    const schemaMatch = liquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
    expect(schemaMatch).not.toBeNull();

    const schema = JSON.parse(schemaMatch![1]);
    const defined: string[] = schema.settings.map(
      (setting: { id: string }) => setting.id,
    );
    const referenced = [...liquid.matchAll(/block\.settings\.(\w+)/g)].map(
      (match) => match[1],
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(defined, `block.settings.${id} has no schema setting`).toContain(id);
    }
  });

  it("keeps the schema valid JSON with a name and target", () => {
    // The theme editor won't offer a block whose schema won't parse.
    const schema = JSON.parse(
      liquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/)![1],
    );

    expect(schema.name).toBeTruthy();
    expect(schema.target).toBeTruthy();
  });

  it("guards on the metafield before rendering anything", () => {
    // Without the guard, a product with no deposit gets an empty notice
    // reading "Includes a refundable Pfand deposit" with no amount.
    expect(liquid).toMatch(/\{%\s*if\s+pfand\.value\s*%\}/);
  });

  it("formats the amount through a money filter", () => {
    // The metafield's raw value is a decimal string; printing it unformatted
    // would show "0.08" with no currency at all.
    expect(liquid).toMatch(/\|\s*money\b/);
  });
});
