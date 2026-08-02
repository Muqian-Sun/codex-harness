import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@codex-harness/app-server-adapter": fileURLToPath(
        new URL("./packages/app-server-adapter/src/index.ts", import.meta.url),
      ),
      "@codex-harness/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["{apps,packages}/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: false,
  },
});
