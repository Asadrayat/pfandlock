import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts. That config exists to run the
// app, so it loads the React Router plugin and reads SHOPIFY_APP_URL/HOST -
// none of which a Node-side unit test needs, and the plugin's route typegen
// makes the run slower and more fragile than the tests themselves.
//
// Scoped to `app/` on purpose: each function extension owns its own vitest
// config and runs against the Shopify function test helpers, so pulling
// extensions/ in here would run those suites twice under the wrong setup.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
