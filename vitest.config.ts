import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@address-radar/domain": fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url)),
      "@address-radar/scoring": fileURLToPath(new URL("./packages/scoring/src/index.ts", import.meta.url)),
    },
  },
  test: {
    passWithNoTests: true,
  },
});
