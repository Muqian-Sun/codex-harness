import { fileURLToPath } from "node:url";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "coverage-cts-transform",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".cts")) {
          return null;
        }

        const result = transpileModule(code, {
          compilerOptions: {
            inlineSources: true,
            module: ModuleKind.CommonJS,
            sourceMap: true,
            target: ScriptTarget.ES2024,
          },
          fileName: id,
        });

        if (result.sourceMapText === undefined) {
          throw new Error(`无法为覆盖率生成 .cts source map：${id}`);
        }

        return {
          code: result.outputText,
          map: result.sourceMapText,
        };
      },
    },
  ],
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
    coverage: {
      provider: "v8",
      include: [
        "apps/**/src/**/*.{ts,tsx,cts}",
        "packages/**/src/**/*.{ts,tsx,cts}",
        "scripts/**/*.mjs",
      ],
      exclude: [
        "**/*.{test,spec}.{ts,tsx,cts,mjs}",
        "**/*.d.ts",
        "packages/app-server-adapter/src/generated/**",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 90,
      },
    },
    environment: "node",
    include: ["{apps,packages}/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.{test,spec}.mjs"],
    passWithNoTests: false,
  },
});
