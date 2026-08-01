import eslint from "@eslint/js";
import globals from "globals";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

const rendererRestrictedImports = [
  ...builtinModules.filter((specifier) => !specifier.startsWith("node:")),
  "electron",
];
const rendererRestrictedGlobals = Object.keys(globals.node).filter(
  (name) => !Object.hasOwn(globals.browser, name),
);

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/*.tsbuildinfo"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: [
      "apps/desktop/src/main/**/*.ts",
      "apps/harnessd/**/*.ts",
      "packages/app-server-adapter/**/*.ts",
      "packages/protocol/**/*.ts",
      "vitest.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: rendererRestrictedImports,
          patterns: ["node:*", "electron/*"],
        },
      ],
      "no-restricted-globals": ["error", ...rendererRestrictedGlobals],
    },
  },
);
