import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { defineConfig } from "vitest/config";

const COVERAGE_CHANGED_ARGUMENT = "--coverage.changed";
const COVERAGE_CHANGED_PREFIX = `${COVERAGE_CHANGED_ARGUMENT}=`;

validateCoverageChangedBaseline(process.argv);

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
    include: ["{apps,packages}/**/*.{test,spec}.{ts,tsx}"],
    passWithNoTests: false,
  },
});

function validateCoverageChangedBaseline(argv: readonly string[]): void {
  if (argv.includes(COVERAGE_CHANGED_ARGUMENT)) {
    throw new Error(
      `覆盖率基准必须使用 ${COVERAGE_CHANGED_PREFIX}<commit-or-branch> 形式显式传入。`,
    );
  }

  const argumentsWithBaseline = argv.filter((argument) =>
    argument.startsWith(COVERAGE_CHANGED_PREFIX),
  );
  if (argumentsWithBaseline.length === 0) {
    return;
  }
  if (argumentsWithBaseline.length !== 1) {
    throw new Error("覆盖率命令只能传入一个 coverage.changed 基准。");
  }

  const baseline = argumentsWithBaseline[0]?.slice(COVERAGE_CHANGED_PREFIX.length) ?? "";
  if (baseline.length === 0) {
    throw new Error("coverage.changed 基准不能为空。");
  }

  try {
    execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baseline}^{commit}`], {
      stdio: "ignore",
    });
  } catch {
    throw new Error(`coverage.changed 基准不可解析为 Git commit：${baseline}`);
  }
}
