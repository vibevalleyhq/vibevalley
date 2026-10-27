import { defineConfig } from "vite-plus";

export default defineConfig({
  // vp dev, build and preview at the root mean the page.
  defaultPackage: "./apps/web",
  // Checks are tasks here and in each package's vite.config.ts: cached, so a run with nothing changed replays its
  // result. What writes files or keeps running (golden:update, api:client, desktop:dev…) stays a package.json script.
  run: {
    tasks: {
      "scripts:test": "vp test run",
      "docs:verify": [
        "vpx scripts/agent-notes.ts",
        "vpx scripts/skills.ts",
        "vpx scripts/doc-links.ts",
        "vpx scripts/stale-names.ts",
        "vpx scripts/capabilities.ts --check",
        "vpx scripts/api-client.ts --check",
      ],
      "notes:verify": "vpx scripts/agent-notes.ts",
      "names:verify": "vpx scripts/stale-names.ts",
      // db:check is a script: it reads ../effect-sqlc, outside what the cache can see.
      "server:check": [
        "vp check",
        "vp run --filter @vibevalley/protocol test",
        "vp run --filter vibevalley-server db:check",
        "vp run --filter vibevalley-server test",
      ],
      "web:check": [
        "vp check",
        "vp run --filter @vibevalley/engine --filter vibevalley-mobile --filter vibevalley-desktop --filter vibevalley-web test",
        "vp run --filter vibevalley-web build",
      ],
      "desktop:test": { command: "vp run --filter vibevalley-desktop e2e", cache: false },
    },
  },
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
    // oxlint's defaults, and import for no-cycle; listing plugins replaces the defaults.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "solid", specifier: "eslint-plugin-solid" },
      { name: "vibevalley", specifier: "./scripts/oxlint-plugin.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "vibevalley/no-comment-divider": "error",
      // [...text] splits by code point, on purpose (docs/style/code.md).
      "typescript/no-misused-spread": "off",
      // A copy before changing what is iterated, on purpose.
      "unicorn/no-useless-spread": "off",
      // const self = this before Effect.gen(function* () { … }).
      "typescript/no-this-alias": "off",
      // Two of oxlint's suspicious rules: an `as` the type already is hides a real cast among the noise, and an error
      // thrown from a catch without { cause } loses the one that happened.
      "typescript/no-unnecessary-type-assertion": "error",
      "eslint/preserve-caught-error": "error",
      // A promise nobody awaits loses its failure, a thrown non-Error loses its stack, and any turns the type checker off.
      "typescript/no-floating-promises": "error",
      "typescript/only-throw-error": "error",
      "typescript/no-explicit-any": "error",
      // A type imported as a value says the module is needed at run time when it is not.
      "typescript/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      // Modules that import each other have no order to read, test or start them in.
      "import/no-cycle": "error",
      // A promise handed where nothing awaits it (a callback, a condition) fails, or is always true, without anyone seeing.
      "typescript/no-misused-promises": "error",
      // A switch on a closed union covers every member, or says with default that the rest are left out on purpose: a
      // member added later is then a compile error where it is not handled (AGENTS.md, 封闭的联合穷尽处理).
      "typescript/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
      // == only against null, where it means null or undefined.
      "eslint/eqeqeq": ["error", "always", { null: "ignore" }],
      // A promise is rejected with an Error, or passes on what it was given (an abort's reason, a caught error).
      "typescript/prefer-promise-reject-errors": ["error", { allowThrowingAny: true, allowThrowingUnknown: true }],
      // Inside try, a promise returned without await escapes its catch and finally.
      "typescript/return-await": "error",
      "eslint/no-fallthrough": "error",
      // A deprecated API is moved off when it is met; one kept on purpose says why at the call.
      "typescript/no-deprecated": "error",
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
        // Shipped code lets no any through: what JSON, a library or a cast gives untyped is typed where it comes in.
        // Tests and scripts read JSON they wrote themselves.
        files: ["apps/*/src/**", "packages/*/src/**"],
        rules: {
          "typescript/no-unsafe-argument": "error",
          "typescript/no-unsafe-assignment": "error",
          "typescript/no-unsafe-call": "error",
          "typescript/no-unsafe-member-access": "error",
          "typescript/no-unsafe-return": "error",
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx", "apps/server/src/testing/**", "apps/server/src/agent/brain/testing.ts"],
        rules: {
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
      {
        // The server logs through Effect (src/base/log.ts for callbacks): levels, and the logger the layer gives. The
        // command line prints.
        files: ["apps/server/src/**"],
        rules: { "no-console": "error", "vibevalley/no-wall-clock": "error" },
      },
      {
        // base/time.ts is where the wall clock is allowed (wallTime, the real-time deadlines); tests drive time as they
        // need.
        files: ["apps/server/src/base/time.ts", "apps/server/src/**/*.test.ts", "apps/server/src/testing/**", "apps/server/src/agent/brain/testing.ts"],
        rules: { "vibevalley/no-wall-clock": "off" },
      },
      {
        // The tests wait on conditions, not on the clock (scripts/oxlint-plugin.ts); testing/ and the pages' fixtures are
        // where the waiting itself is written.
        files: ["apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx", "apps/web/test/**", "apps/desktop/test/**", "packages/*/src/**/*.test.ts"],
        rules: { "vibevalley/no-test-sleep": "error" },
      },
      {
        files: ["apps/web/test/fixtures.ts", "apps/web/test/global-setup.ts"],
        rules: { "vibevalley/no-test-sleep": "off" },
      },
      {
        // What the shipped code says is in word tables (scripts/oxlint-plugin.ts, no-cjk-literal): Chinese is written
        // only in them, in what is said to models, and in the tests.
        files: ["apps/*/src/**", "packages/*/src/**", "apps/mobile/App.tsx"],
        rules: { "vibevalley/no-cjk-literal": "error" },
      },
      {
        files: [
          "**/words.ts",
          "**/words/**",
          "**/prompts.ts",
          "**/*.test.ts",
          "**/*.test.tsx",
          "apps/server/src/testing/**",
          "apps/server/src/**/testing.ts",
          // Made-up memories shown until the server sums them up.
          "apps/web/src/tree/mock.ts",
        ],
        rules: { "vibevalley/no-cjk-literal": "off" },
      },
      {
        files: ["apps/server/src/cli.ts", "apps/server/src/cli/**", "apps/server/src/**/*.test.ts", "apps/server/src/testing/**"],
        rules: { "no-console": "off" },
      },
      {
        // The page's layers and its features' indexes (scripts/oxlint-plugin.ts, page-layers).
        files: ["apps/web/src/**"],
        rules: { "vibevalley/page-layers": "error" },
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
                  message: "Use base/query.ts's useQuery: it runs the fetch untracked.",
                },
                { name: "bun:test", message: "Tests run on vitest: import from vite-plus/test." },
              ],
            },
          ],
        },
      },
    ],
    // A disable comment whose rule no longer fires there is an error, so none outlives its reason.
    options: { typeAware: true, typeCheck: true, reportUnusedDisableDirectives: "error" },
  },
});
