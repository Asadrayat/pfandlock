import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts. That config exists to run the
// app, so it loads the React Router plugin and reads SHOPIFY_APP_URL/HOST -
// none of which a Node-side unit test needs, and the plugin's route typegen
// makes the run slower and more fragile than the tests themselves.
//
// The two *function* extensions are deliberately not included: each owns a
// vitest config and runs against the Shopify function test helpers, so
// pulling them in here would run those suites twice under the wrong setup.
//
// deposit-notice is the exception. It's a theme extension with no package
// of its own and nothing to build - its tests only read files - so this is
// the only runner it has.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts", "extensions/deposit-notice/**/*.test.ts"],
    environment: "node",
  },
});
