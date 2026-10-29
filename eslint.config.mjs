import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // `services/print-pdf` is its own CommonJS Node service with its own package.json and image (share-kit D12), not
  // part of the Next app — `require` is its module system there.
  {
    files: ["services/**/*.js"],
    // no-undef: a call to an unimported guard helper parsed fine, passed every test, and failed every render in
    // production (share-kit PR 450). The globals are listed here rather than imported from `globals`, which is only
    // a transitive dependency of this app.
    languageOptions: {
      sourceType: "commonjs",
      globals: Object.fromEntries(
        ["require", "module", "process", "console", "Buffer", "setTimeout", "clearTimeout", "__dirname", "URL", "document"]
          .map((name) => [name, "readonly"]),
      ),
    },
    rules: { "@typescript-eslint/no-require-imports": "off", "no-undef": "error" },
  },
]);

export default eslintConfig;
