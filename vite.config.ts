import { defineConfig } from "vite-plus";

import { effectRules } from "./scripts/effect-lint.ts";
import { says } from "./scripts/oxlint-plugin.ts";

// What no-restricted-imports says, each written once: what is wrong, how to fix it, and where to look
// (scripts/oxlint-plugin.ts, says; its test reads these too).
export const refused = {
  bunTest: says(
    "tests run on vitest, not bun",
    'import { describe, expect, it } from "vite-plus/test" (in the server, `it.effect` from "@effect/vitest")',
    "docs/subsystems/foundation.md",
  ),
  tempDir: says(
    "a folder from mkdtempSync stays behind after the run",
    "`tempDir()` from @vibevalley/testkit/temp, which removes it when the run ends",
    "packages/testkit/src/temp.ts",
  ),
  agentWords: says(
    "the agent says nothing to the owner: the server words what it did",
    "return a value or a tagged error, and let apps/server turn it into words with t()",
    "packages/agent/README.md",
  ),
  agentContract: says(
    "the agent knows nothing of the farm's contract, so it runs without the farm",
    "take what it needs as a parameter or an interface in packages/agent, and let apps/server fit the farm's shapes to it",
    "packages/agent/README.md",
  ),
  packageToApp: says(
    "a package does not reach into an app: apps depend on packages, never back",
    "move what both need into the package, or have the app pass it in",
    "docs/architecture.md",
  ),
  aiToAgent: says("packages/ai knows nothing of the agent, which is built on it", "move what ai needs down into packages/ai", "packages/ai/README.md"),
  coreToBrain: says(
    "the agent's core does not import its brain: the brain is built on core",
    "move what core needs into packages/agent/src/core, or pass it in",
    "packages/agent/README.md",
  ),
  react: says(
    "the page is Solid 2; a React import resolves only because apps/mobile installs React",
    "use solid-js, and the Solid version of the library",
    "apps/web/README.md",
  ),
  useQuery: says(
    "solid-query's useQuery tracks what its fetch reads, so a signal read inside refetches",
    'import { useQuery } from "@/infra/query"',
    "apps/web/src/infra/query.ts",
  ),
};

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
        "vpx scripts/glossary.ts",
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
        "vp run --filter @vibevalley/bridge --filter @vibevalley/engine --filter @vibevalley/base-ui --filter @vibevalley/stories --filter @vibevalley/i18n --filter @vibevalley/mobile --filter @vibevalley/desktop --filter @vibevalley/web test",
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
        "effect-tsgo diagnostics --project packages/bridge/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/testkit/tsconfig.json --strict",
        "effect-tsgo diagnostics --project packages/health/tsconfig.json --strict",
        "effect-tsgo diagnostics --project apps/web/tsconfig.json --strict",
        "effect-tsgo diagnostics --project apps/desktop/tsconfig.json --strict",
      ],
      // Files, exports and dependencies nothing uses (knip.ts says what runs; scripts/deadcode.ts says what to do).
      deadcode: "vpx scripts/deadcode.ts",
      "desktop:test": { command: "vp run --filter @vibevalley/desktop e2e", cache: false },
    },
  },
  // scripts/'s own tests; each package has its vite.config.ts with its own.
  test: { include: ["scripts/**/*.test.ts"] },
  // The pre-commit hook (.vite-hooks/pre-commit) runs these on the staged files.
  staged: { "*": "vp check --fix --deny-warnings" },
  fmt: {
    printWidth: 160,
    // site/ is its own project; the rest are written by tools or are data, and docs keep their compact tables.
    ignorePatterns: ["site/**", "**/*.md", "apps/server/db/generated/**", "**/testdata/**", "apps/web/public/**", ".agents/**", "design/**"],
    // Imports from farthest to nearest: Node, packages, the workspace's own, this app's @/, then the same folder.
    sortImports: {
      customGroups: [{ groupName: "workspace", elementNamePattern: ["@vibevalley/**"] }],
      groups: ["builtin", "external", "workspace", ["internal", "subpath"], ["parent", "sibling", "index"], "style", "unknown"],
    },
    // Tailwind's own class order, from the page's stylesheet; cx(…) holds classes too.
    sortTailwindcss: { stylesheet: "./apps/web/src/style.css", functions: ["cx"] },
  },
  lint: {
    ignorePatterns: ["site/**", "apps/server/db/generated/**"],
    // oxlint's defaults, import for no-cycle, and effecttsgo: Effect's rules, patched into oxlint by package.json's prepare
    // (scripts/effect-lint.ts); listing plugins replaces the defaults.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "effecttsgo"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "solid", specifier: "eslint-plugin-solid" },
      { name: "vibevalley", specifier: "./scripts/oxlint-plugin.ts" },
    ],
    rules: {
      ...effectRules(),
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
      // A module imported twice says two things about one dependency.
      "import/no-duplicates": "error",
      // Type arguments, conversions and type parameters that change nothing are noise a reader has to see through.
      "typescript/no-unnecessary-type-arguments": "error",
      "typescript/no-unnecessary-type-conversion": "error",
      "typescript/no-unnecessary-type-parameters": "error",
      // A spread inside a reduce copies everything so far on every step: quadratic.
      "oxc/no-accumulating-spread": "error",
      "unicorn/prefer-set-has": "error",
      "unicorn/prefer-array-find": "error",
      // A condition is a boolean or a string. "" is a string's none (docs/style/code.md, 没有值), so a string reads as
      // "is there one"; a number's 0 is a value, not none; an object is always true; a nullable object is checked for
      // being there.
      "typescript/strict-boolean-expressions": [
        "error",
        {
          allowString: true,
          allowNullableString: true,
          allowNumber: false,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableNumber: false,
        },
      ],
      // x || d takes 0 and false for none; ?? takes only null and undefined. A string's "" is its none, so || stays for strings.
      "typescript/prefer-nullish-coalescing": ["error", { ignorePrimitives: { string: true } }],
      // A cast that narrows is a claim nothing checks: read it with a Schema or a guard, or say at the cast why it holds.
      "typescript/no-unsafe-type-assertion": "error",
      // Without u a pattern matches UTF-16 units: an emoji or a rare Han character is two of them, and . or [^x] splits it.
      "eslint/require-unicode-regexp": "error",
      // Frames and the core state are shared: sorting or reversing one in place changes it for everyone holding it.
      "unicorn/no-array-sort": "error",
      "unicorn/no-array-reverse": "error",
      // Awaits one after another in a loop: either the steps depend on each other, which the code says where it does it,
      // or they could run together.
      "eslint/no-await-in-loop": "error",
      // ({ secret: _, ...rest }) leaves a field out.
      "eslint/no-unused-vars": ["error", { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
    overrides: [
      {
        // Tests are vitest's, on Node.
        files: ["apps/**", "packages/**", "scripts/**"],
        rules: { "no-restricted-imports": ["error", { paths: [{ name: "bun:test", message: refused.bunTest }] }] },
      },
      {
        // The server's tests make their folders with tempDir, which removes them when the run ends.
        files: ["apps/server/src/**"],
        excludeFiles: ["apps/server/src/**/*.stories.tsx"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [
                { name: "bun:test", message: refused.bunTest },
                { name: "node:fs", importNames: ["mkdtempSync"], message: refused.tempDir },
              ],
            },
          ],
        },
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
        // A test's cast is checked by the test: a wrong claim fails the expectation that reads it. Stories and samples are
        // looked at.
        files: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "**/*.stories.tsx",
          "**/*.samples.ts",
          "apps/*/test/**",
          "packages/*/test/**",
          "apps/server/src/testing/**",
          "packages/*/src/testing.ts",
          "packages/testkit/src/**",
        ],
        rules: { "typescript/no-unsafe-type-assertion": "off" },
      },
      {
        // Playwright drives one page: its steps cannot run together.
        files: ["apps/*/test/**/*.spec.ts", "apps/*/test/fixtures.ts"],
        rules: { "eslint/no-await-in-loop": "off" },
      },
      {
        // The server logs through Effect (src/infra/log.ts for callbacks): levels, and the logger the layer gives; so does
        // the agent it runs on. The command line prints.
        files: ["apps/server/src/**", "packages/ai/src/**", "packages/agent/src/**"],
        rules: { "no-console": "error", "vibevalley/no-wall-clock": "error" },
      },
      {
        // infra/time.ts and the agent's realTime.ts are where the wall clock is allowed (wallTime, the real-time
        // deadlines); tests drive time as they need.
        files: [
          "apps/server/src/infra/time.ts",
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
                { name: "bun:test", message: refused.bunTest },
                { name: "@vibevalley/i18n", message: refused.agentWords },
                { name: "@vibevalley/protocol", message: refused.agentContract },
              ],
              patterns: [
                { group: ["**/apps/**", "@vibevalley/server", "@vibevalley/server/*"], message: refused.packageToApp },
                { group: ["@vibevalley/agent", "@vibevalley/agent/*"], message: refused.aiToAgent },
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
                { name: "bun:test", message: refused.bunTest },
                { name: "@vibevalley/i18n", message: refused.agentWords },
                { name: "@vibevalley/protocol", message: refused.agentContract },
              ],
              patterns: [{ group: ["**/apps/**", "@vibevalley/server", "@vibevalley/server/*"], message: refused.packageToApp }],
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
              paths: [{ name: "bun:test", message: refused.bunTest }],
              patterns: [
                { group: ["**/apps/**", "@vibevalley/server", "@vibevalley/server/*"], message: refused.packageToApp },
                { group: ["../*"], message: refused.coreToBrain },
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
        // The server is Effect; a Promise is only a library's one call (scripts/oxlint-plugin.ts, promise-boundary).
        files: ["apps/server/src/**"],
        excludeFiles: ["apps/server/src/**/*.test.ts", "apps/server/src/testing/**", "apps/server/src/flows/**"],
        rules: { "vibevalley/promise-boundary": "error" },
      },
      {
        // A tryPromise without catch fails with UnknownError and loses the real cause (scripts/oxlint-plugin.ts, try-promise-catch).
        files: ["apps/server/src/**", "packages/agent/src/**", "packages/ai/src/**"],
        excludeFiles: ["**/*.test.ts"],
        rules: { "vibevalley/try-promise-catch": "error" },
      },
      {
        // Errors are told apart by their tag, not their class (scripts/oxlint-plugin.ts, no-instanceof-tagged).
        files: ["apps/server/src/**", "packages/agent/src/**", "packages/ai/src/**"],
        excludeFiles: ["**/*.test.ts"],
        rules: { "vibevalley/no-instanceof-tagged": "error" },
      },
      {
        // Unknown values are read with Predicate or a Schema, not a hand-written object check (scripts/oxlint-plugin.ts, no-object-guard).
        files: ["apps/server/src/**", "packages/agent/src/**", "packages/ai/src/**", "packages/protocol/src/**"],
        excludeFiles: ["**/*.test.ts"],
        rules: { "vibevalley/no-object-guard": "error" },
      },
      {
        // Interfaces that are Promises by the library's design: oar's runtimes (its runtime and session calls), the MCP
        // SDK's request handlers, the fetch that the model client calls for the local chat/completions, and time.ts, the
        // service's Clock as Promises for the code on those interfaces (oar's vibevalley runtime, the journal).
        files: [
          "apps/server/src/runtime/vibevalley.ts",
          "apps/server/src/runtime/dsh.ts",
          "apps/server/src/runtime/pi.ts",
          "apps/server/src/runtime/runtime.ts",
          "apps/server/src/mcp/mcp.ts",
          "apps/server/src/orchestrator/openai.ts",
          "apps/server/src/infra/time.ts",
        ],
        rules: { "vibevalley/promise-boundary": "off" },
      },
      {
        // A global is declared once in its door and read with its type (scripts/oxlint-plugin.ts, global-doors).
        files: ["apps/**", "packages/**", "scripts/**"],
        rules: { "vibevalley/global-doors": "error" },
      },
      {
        // The doors: the page and its shells (protocol's host.ts), the desktop's test probe, the page's test marks.
        files: ["packages/protocol/src/host.ts", "apps/desktop/src/probe.ts", "apps/web/test/marks.ts"],
        rules: { "vibevalley/global-doors": ["error", { door: true }] },
      },
      {
        // One word for none (scripts/oxlint-plugin.ts, one-absent).
        files: ["apps/**", "packages/**"],
        excludeFiles: ["apps/server/db/generated/**"],
        rules: { "vibevalley/one-absent": "error" },
      },
      {
        // Doors to the outside, where null comes in and is turned into undefined: a stored column's text, the DOM's body.
        files: ["apps/server/src/base/json.ts", "apps/web/src/features/channel/draft.ts"],
        rules: { "vibevalley/one-absent": "off" },
      },
      {
        // A service's methods open a span named after them, so the traces show each call (scripts/oxlint-plugin.ts, service-method-names).
        files: ["apps/server/src/**"],
        excludeFiles: ["apps/server/src/**/*.test.ts", "apps/server/src/testing/**"],
        rules: { "vibevalley/service-method-names": "error" },
      },
      {
        // A server service takes its concept's singular word (scripts/oxlint-plugin.ts, singular-service).
        files: ["apps/server/src/**"],
        rules: { "vibevalley/singular-service": "error" },
      },
      {
        // A protocol shape named like a service is read as T.X, so the service keeps the name (scripts/oxlint-plugin.ts, protocol-namespace).
        files: ["apps/server/src/**"],
        excludeFiles: ["apps/server/src/**/*.test.ts", "apps/server/src/testing/**"],
        rules: { "vibevalley/protocol-namespace": "error" },
      },
      {
        // Only the page's state/ stands on Effect's Atom, whose API is unstable (scripts/oxlint-plugin.ts, atom-door).
        files: ["apps/web/src/**"],
        rules: { "vibevalley/atom-door": "error" },
      },
      {
        // A value the page keeps for its life is an atom of the page's, not a signal made outside any function (scripts/oxlint-plugin.ts, page-store).
        files: ["apps/web/src/features/**", "apps/web/src/farm/**", "apps/web/src/ui/**"],
        excludeFiles: ["apps/web/src/**/*.test.ts"],
        rules: { "vibevalley/page-store": "error" },
      },
      {
        // The browser's storage only through state/stored.ts (scripts/oxlint-plugin.ts, stored-door).
        files: ["apps/web/src/**"],
        rules: { "vibevalley/stored-door": "error" },
      },
      {
        // What the owner does from a component goes through an Act or an intent (scripts/oxlint-plugin.ts, act-door).
        files: ["apps/web/src/features/**/*.tsx", "apps/web/src/farm/**/*.tsx"],
        excludeFiles: ["apps/web/src/**/*.stories.tsx"],
        rules: { "vibevalley/act-door": "error" },
      },
      {
        // A refusal is said in the error tone (scripts/oxlint-plugin.ts, failure-tone).
        files: ["apps/web/src/**"],
        rules: { "vibevalley/failure-tone": "error" },
      },
      {
        // The server reaches the database through Db, which decides what a failed query becomes (scripts/oxlint-plugin.ts, db-door).
        files: ["apps/server/src/**"],
        excludeFiles: ["apps/server/src/**/*.test.ts", "apps/server/src/testing/**"],
        rules: { "vibevalley/db-door": "error" },
      },
      {
        // A page timer keeps its handle, to be cleared when its part goes (scripts/oxlint-plugin.ts, dropped-timer).
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/**/*.test.ts", "apps/web/src/**/*.stories.tsx"],
        rules: { "vibevalley/dropped-timer": "error" },
      },
      {
        // A process is started only by its door: one per kind, which kills the group on a timeout (scripts/oxlint-plugin.ts, child-process-door).
        files: ["apps/**", "packages/**"],
        excludeFiles: [
          "**/scripts/**",
          "apps/server/src/project/git.ts",
          "apps/server/src/runtime/dsh.ts",
          "apps/server/src/voice/voice.ts",
          "apps/server/src/testing/git.ts",
          "apps/server/src/testing/helper.ts",
          "apps/desktop/src/island.ts",
          "apps/desktop/src/server.ts",
          "apps/desktop/src/update.ts",
          "apps/web/test/fixtures.ts",
          "apps/web/test/global-setup.ts",
          "packages/agent/src/coding.ts",
          "packages/health/src/collect.ts",
        ],
        rules: { "vibevalley/child-process-door": "error" },
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
                  message: refused.react,
                })),
                {
                  name: "@tanstack/solid-query",
                  importNames: ["useQuery"],
                  message: refused.useQuery,
                },
                { name: "bun:test", message: refused.bunTest },
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
