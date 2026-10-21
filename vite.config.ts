import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 160,
    // site/ is its own project; the rest are written by tools or are data, and docs keep their compact tables.
    ignorePatterns: ["site/**", "**/*.md", "apps/server/db/generated/**", "**/testdata/**", "apps/web/public/**", ".agents/**", "design/**"],
  },
  lint: {
    ignorePatterns: ["site/**", "apps/server/db/generated/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // [...text] splits by code point, on purpose (docs/style/code.md).
      "typescript/no-misused-spread": "off",
      // A copy before changing what is iterated, on purpose.
      "unicorn/no-useless-spread": "off",
      // const self = this before Effect.gen(function* () { … }).
      "typescript/no-this-alias": "off",
      // ({ secret: _, ...rest }) leaves a field out.
      "eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
    options: { typeAware: true, typeCheck: true },
  },
});
