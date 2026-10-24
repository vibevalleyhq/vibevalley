import { defineConfig } from "vite-plus";

export default defineConfig({
  // scripts/'s own tests; each package has its vite.config.ts with its own.
  test: { include: ["scripts/**/*.test.ts"] },
  // The pre-commit hook (.vite-hooks/pre-commit) runs these on the staged files.
  staged: { "*": "vp check --fix" },
  fmt: {
    printWidth: 160,
    // site/ is its own project; the rest are written by tools or are data, and docs keep their compact tables.
    ignorePatterns: ["site/**", "**/*.md", "apps/server/db/generated/**", "**/testdata/**", "apps/web/public/**", ".agents/**", "design/**"],
  },
  lint: {
    ignorePatterns: ["site/**", "apps/server/db/generated/**"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "solid", specifier: "eslint-plugin-solid" },
    ],
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
    overrides: [
      {
        // Tests are vitest's, on Node.
        files: ["apps/**", "packages/**", "scripts/**"],
        rules: { "no-restricted-imports": ["error", { paths: [{ name: "bun:test", message: "Tests run on vitest: import from vite-plus/test." }] }] },
      },
      {
        // The server logs through Effect (src/base/log.ts for callbacks): levels, and the logger the layer gives. The
        // command line prints, and the brain and the journal are plain classes outside Effect.
        files: ["apps/server/src/**"],
        rules: { "no-console": "error" },
      },
      {
        files: [
          "apps/server/src/cli.ts",
          "apps/server/src/cli/**",
          "apps/server/src/agent/brain/**",
          "apps/server/src/**/*.test.ts",
          "apps/server/src/testing/**",
        ],
        rules: { "no-console": "off" },
      },
      {
        // eslint-plugin-solid's v2 config, for the page: the 1.x APIs, one-argument effects, destructured props, accessors
        // passed as props, writes inside computations. Its server-function rules are left out: there are none here.
        files: ["apps/web/src/**"],
        rules: {
          "solid/jsx-no-duplicate-props": "error",
          "solid/jsx-no-undef": "error",
          "solid/jsx-uses-vars": "error",
          "solid/no-unknown-namespaces": "error",
          "solid/no-innerhtml": "error",
          "solid/jsx-no-script-url": "error",
          "solid/components-return-once": "error",
          "solid/no-destructure": "error",
          "solid/prefer-for": "error",
          // Our own primitives are named create* or use*, as the rule expects of functions that take accessors.
          "solid/reactivity": "error",
          "solid/event-handlers": "error",
          "solid/imports": "error",
          "solid/style-prop": "error",
          "solid/no-react-specific-props": "error",
          "solid/self-closing-comp": "error",
          "solid/removed-api": "error",
          "solid/no-single-arg-create-effect": "error",
          "solid/no-store-mutation-outside-setter": "error",
          "solid/no-write-in-pure-computation": "error",
          "solid/no-unused-signal": "error",
          "solid/no-accessor-as-prop": "error",
          "solid/no-boolean-enumerated-attribute": "error",
          "solid/prefer-structured-class": "error",
          // React is still installed for apps/mobile, so an import of it would resolve here.
          "no-restricted-imports": [
            "error",
            {
              paths: [
                ...["react", "react-dom", "react-router", "@tanstack/react-query", "react-markdown"].map((name) => ({
                  name,
                  message: "The page is Solid 2 (apps/web/README.md).",
                })),
                {
                  name: "@tanstack/solid-query",
                  importNames: ["useQuery"],
                  message: "Use data/query.ts's useQuery: it runs the fetch untracked.",
                },
                { name: "bun:test", message: "Tests run on vitest: import from vite-plus/test." },
              ],
            },
          ],
        },
      },
    ],
    options: { typeAware: true, typeCheck: true },
  },
});
