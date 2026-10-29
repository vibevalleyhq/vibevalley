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
        "vpx scripts/i18n.ts check",
        "vpx scripts/capabilities.ts --check",
        "vpx scripts/api-client.ts --check",
      ],
      "notes:verify": "vpx scripts/agent-notes.ts",
      "names:verify": "vpx scripts/stale-names.ts",
      // db:check is a script: it reads ../effect-sqlc, outside what the cache can see.
      "server:check": [
        "vp check",
        "vp run --filter @vibevalley/protocol --filter @vibevalley/testkit --filter @vibevalley/ai --filter @vibevalley/agent test",
        "vp run effect:check",
        "vp run --filter @vibevalley/server db:check",
        "vp run --filter @vibevalley/server test",
      ],
      "web:check": ["vp check", "vp run web:test"],
      // web:check without its vp check: CI's web job runs this one, and its check job runs vp check.
      "web:test": [
        "vp run --filter @vibevalley/engine --filter @vibevalley/base-ui --filter @vibevalley/stories --filter @vibevalley/i18n --filter @vibevalley/mobile --filter @vibevalley/desktop --filter @vibevalley/web test",
        "vp run --filter @vibevalley/web build",
        "vp run --filter @vibevalley/web build:stories",
      ],
      // The health package's tests, then the escape ratchet (scripts/health.config.ts); the report is `vp run health`.
      "health:verify": ["vp run --filter @vibevalley/health test", "vpx packages/health/src/cli.ts --config scripts/health.config.ts --check"],
      // Effect's own diagnostics (@effect/tsgo; which rules and how strict is tsconfig.base.json's plugins), a warning failing.
      "effect:check": [
        "effect-tsgo diagnostics --project apps/server/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/agent/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/ai/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/protocol/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/testkit/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/health/tsconfig.json --strict",
        "effect-tsgo diagnostics --project apps/web/tsconfig.json --strict",
        "effect-tsgo diagnostics --project apps/desktop/tsconfig.json --strict",
      ],
      "desktop:test": { command: "vp run --filter @vibevalley/desktop e2e", cache: false },
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
        files: ["**/*.test.ts", "**/*.test.tsx", "apps/server/src/testing/**", "packages/*/src/testing.ts", "packages/testkit/src/**"],
        rules: {
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
      {
        // The server logs through Effect (src/base/log.ts for callbacks): levels, and the logger the layer gives; so does
        // the agent it runs on. The command line prints.
        files: ["apps/server/src/**", "packages/ai/src/**", "packages/agent/src/**"],
        rules: { "no-console": "error", "vibevalley/no-wall-clock": "error" },
      },
      {
        // base/time.ts and the agent's realTime.ts are where the wall clock is allowed (wallTime, the real-time
        // deadlines); tests drive time as they need.
        files: [
          "apps/server/src/base/time.ts",
          "packages/agent/src/realTime.ts",
          "apps/server/src/**/*.test.ts",
          "packages/*/src/**/*.test.ts",
          "apps/server/src/testing/**",
          "packages/*/src/testing.ts",
        ],
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
        // What the shipped code says to the owner is in the catalogs (packages/i18n/locales, read as t("key");
        // scripts/oxlint-plugin.ts, no-cjk-literal): Chinese is written only there, in what is said to models, and in the tests.
        files: ["apps/*/src/**", "packages/*/src/**", "apps/mobile/App.tsx"],
        rules: { "vibevalley/no-cjk-literal": "error" },
      },
      {
        files: [
          // Written by scripts/i18n.ts gen from the catalogs.
          "packages/i18n/src/catalogs.ts",
          "**/prompts.ts",
          "**/*.test.ts",
          "**/*.test.tsx",
          // Stories and their made-up samples, shown only in the stories' page (apps/web/stories.html), and their levels'
          // names.
          "**/*.stories.tsx",
          "**/*.samples.ts",
          "apps/web/src/storyLevels.ts",
          "apps/server/src/testing/**",
          "apps/server/src/**/testing.ts",
          "packages/*/src/testing.ts",
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
        // The model's package knows nothing of the agent, and neither knows the farm: no app, no owner's words, no
        // contract with the page (the later override for packages/agent replaces this one there).
        files: ["packages/ai/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                { name: "bun:test", message: "Tests run on vitest: import from vite-plus/test." },
                { name: "@vibevalley/i18n", message: "The agent says nothing to the owner: return a value or an error the server words." },
                { name: "@vibevalley/protocol", message: "The agent knows nothing of the farm's contract." },
              ],
              patterns: [
                { group: ["**/apps/**", "@vibevalley/server", "@vibevalley/server/*"], message: "A package does not reach into an app." },
                { group: ["@vibevalley/agent", "@vibevalley/agent/*"], message: "packages/ai knows nothing of the agent." },
              ],
            },
          ],
        },
      },
      {
        files: ["packages/agent/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                { name: "bun:test", message: "Tests run on vitest: import from vite-plus/test." },
                { name: "@vibevalley/i18n", message: "The agent says nothing to the owner: return a value or an error the server words." },
                { name: "@vibevalley/protocol", message: "The agent knows nothing of the farm's contract." },
              ],
              patterns: [{ group: ["**/apps/**", "@vibevalley/server", "@vibevalley/server/*"], message: "A package does not reach into an app." }],
            },
          ],
        },
      },
      {
        // The loop and its tools stand alone: the brain is built on core, never the other way.
        files: ["packages/agent/src/core/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [{ name: "bun:test", message: "Tests run on vitest: import from vite-plus/test." }],
              patterns: [
                { group: ["**/apps/**", "@vibevalley/server", "@vibevalley/server/*"], message: "A package does not reach into an app." },
                { group: ["../*"], message: "core does not import the brain: the brain imports core." },
              ],
            },
          ],
        },
      },
      {
        // The workbench's values are on the design ladders (scripts/oxlint-plugin.ts: design-tokens; docs/style/design.md);
        // the pixel skin and the avatars are drawn to their own sizes.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/farm/**", "apps/web/src/tree/**", "apps/web/src/ui/pixel/**", "apps/web/src/ui/Face.tsx", "apps/web/src/**/*.test.ts"],
        rules: { "vibevalley/design-tokens": "error", "vibevalley/native-control": "error" },
      },
      {
        // Every colour of the page is named in style.css, the pixel skin's too: its palette does not follow the theme, but
        // a drawn colour has a name like any other. The avatars' colours are data (ui/cast.ts) and keep their values.
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/ui/Face.tsx", "apps/web/src/**/*.test.ts"],
        rules: { "vibevalley/no-hex-color": "error" },
      },
      {
        // Page tests find elements by data-testid and state attributes, not by the interface's words
        // (scripts/oxlint-plugin.ts, no-copy-selector; docs/subsystems/foundation.md).
        files: ["apps/web/test/**", "apps/desktop/test/**"],
        rules: { "vibevalley/no-copy-selector": "error" },
      },
      {
        // The page's layers and its features' indexes (scripts/oxlint-plugin.ts, page-layers).
        files: ["apps/web/src/**"],
        rules: { "vibevalley/page-layers": "error" },
      },
      {
        // An import from outside its folder is written from src, as @/… (scripts/oxlint-plugin.ts, parent-import).
        files: ["apps/web/src/**", "apps/server/src/**"],
        rules: { "vibevalley/parent-import": "error" },
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
