import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@address-radar/domain": fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url)),
      "@address-radar/database": fileURLToPath(new URL("./packages/database/src/index.ts", import.meta.url)),
      "@address-radar/identity": fileURLToPath(new URL("./packages/identity/src/index.ts", import.meta.url)),
      "@address-radar/scoring": fileURLToPath(new URL("./packages/scoring/src/index.ts", import.meta.url)),
      "@address-radar/collectors": fileURLToPath(new URL("./packages/collectors/src/index.ts", import.meta.url)),
      "@address-radar/aggregation": fileURLToPath(new URL("./packages/aggregation/src/index.ts", import.meta.url)),
      "@address-radar/signal-engine": fileURLToPath(new URL("./packages/signal-engine/src/index.ts", import.meta.url)),
      "@address-radar/observability": fileURLToPath(new URL("./packages/observability/src/index.ts", import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    passWithNoTests: true,
  },
});
