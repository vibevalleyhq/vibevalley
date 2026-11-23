import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "vite-plus";

import { says } from "./scripts/audit/oxlint-plugin.ts";

// `apps/mac/ui/.nsh/tsconfig.json` and `apps/mobile/.nsh/tsconfig.json` are generated on macOS by `nsh check` (gitignored).
// Linux CI (`ci.yml`) cannot install the macOS-only nsh CLI, so type-aware lint skips each app only when its `.nsh/tsconfig.json` is absent.
const hasNshTypes = existsSync(resolve(import.meta.dirname, "apps/mac/ui/.nsh/tsconfig.json"));
const hasMobileNshTypes = existsSync(resolve(import.meta.dirname, "apps/mobile/.nsh/tsconfig.json"));

// What no-restricted-imports says, each written once: what is wrong, how to fix it, and where to look
// (scripts/audit/oxlint-plugin.ts, says; its test reads these too).
export const refused = {
  bunTest: says("tests run on vitest, not bun", 'import { describe, expect, it } from "vite-plus/test"', "docs/subsystems/foundation.md"),
};

export default defineConfig({
  // vp dev, build and preview at the root mean the site: the app is Rust (apps/mac), built by cargo.
  defaultPackage: "./apps/site",
  // Checks are tasks here and in each package's vite.config.ts: cached, so a run with nothing changed replays its
  // result. What writes files (api:client, protocol:ts…) stays a package.json script.
  run: {
    tasks: {
      "scripts:test": { command: "vp test run", cache: false },
      "docs:verify": [
        "vpx scripts/docs/agent-notes.ts",
        "vpx scripts/docs/skills.ts",
        "vpx scripts/docs/doc-links.ts",
        "vpx scripts/docs/stale-names.ts",
        "vpx scripts/docs/glossary.ts",
        "vpx scripts/gen/i18n.ts check",
        "vpx scripts/gen/capabilities.ts --check",
        "vpx scripts/gen/api-client.ts --check",
        "vpx scripts/gen/primitives.ts --check",
        "vpx scripts/gen/icons.ts --check",
      ],
      "notes:verify": "vpx scripts/docs/agent-notes.ts",
      "site:check": { command: "vp run --filter @vibevalley/site check", cache: false },
      "site:build": { command: "vp run --filter @vibevalley/site build", cache: false },
      // The types each package gives the others (its pack block, dist/): what vp check reads a workspace package by, so
      // every check builds them first. Cached, so a package nobody changed is not built again; vp install runs it too.
      "packages:build": ["vp run --filter './packages/*' build", "vpx scripts/audit/built-types.ts"],
      "names:verify": "vpx scripts/docs/stale-names.ts",
      // The TS packages the native views and the generators still use; the server and the command line are Rust (rust:check).
      "packages:check": [
        "vp run packages:build",
        "vp check",
        "vp run --filter @vibevalley/protocol --filter @vibevalley/i18n --filter @vibevalley/testkit test",
      ],
      // Files, exports and dependencies nothing uses (knip.ts says what runs; scripts/audit/deadcode.ts says what to do).
      deadcode: "vpx scripts/audit/deadcode.ts",
      // Static Rust module boundary gate (L0-L3 DAG, acyclicity, spine/mac isolation; docs/architecture-topology.md Section 3.2.2).
      "audit:boundaries": { command: "vpx scripts/audit/module-boundaries.ts", cache: false },
      // The Rust workspace (crates/, apps/mac): format, clippy, tests. protocol:check fails when packages/protocol's
      // shapes.gen.ts differ from the Rust contract (vp run protocol:ts writes them), or the artifact goldens from
      // its engine (vp run goldens).
      "rust:check": {
        command:
          "cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && { if command -v cargo-nextest >/dev/null 2>&1; then cargo nextest run --workspace --no-fail-fast && cargo test --workspace --doc; else cargo test --workspace; fi; }",
        cache: false,
      },
      "rust:changed": { command: "vpx scripts/release/rust-changed.ts", cache: false },
      "rust:loom": {
        command:
          "cargo test --release -p vibevalley-runtime --features loom --lib loom_models && cargo test --release -p vibevalley-server --features loom --lib loom_models",
        cache: false,
      },
      "protocol:check": {
        command: "cargo test -p vibevalley-protocol --features ts-gen --test typescript && vp run goldens --check",
        cache: false,
      },
      // Inside release:verify, rust:check already runs every vibevalley-core golden test; serialize the ts-gen check
      // after rust:check so Cargo never contends on .cargo-lock and goldens never run twice.
      "release:rust": {
        command: "cargo test -p vibevalley-protocol --features ts-gen --test typescript",
        dependsOn: ["rust:check"],
        cache: false,
      },
      "sql:check": { command: "sqlc diff && python3 scripts/release/verify-native-schema.py --queries-only", cache: false },
      "mac:build-test": {
        command:
          'cd apps/mac/ui && ../../../.tools/bin/nsh check && (../../../.tools/bin/nsh build App.tsx -o build & p1=$!; ../../../.tools/bin/nsh build ShellApp.tsx -o build-shell & p2=$!; s=0; wait "$p1" || s=$?; wait "$p2" || s=$?; exit "$s") && cd ../../.. && vpx scripts/audit/mac-tests.ts',
        cache: false,
      },
      "mac:check": {
        command: "vp lint --deny-warnings apps/mac/ui",
        dependsOn: ["mac:build-test"],
        cache: false,
      },
      "mobile:check": {
        command:
          "cd apps/mobile && ../../.tools/bin/nsh check && ../../.tools/bin/nsh build App.tsx -o build && ../../.tools/bin/nsh test && cd ../.. && vp lint --deny-warnings apps/mobile",
        cache: false,
      },
      // packages:check already runs type-aware vp check across apps/mac/ui, so release:verify uses mac:build-test to avoid linting twice.
      "release:verify": {
        command: "true",
        dependsOn: ["release:rust", "sql:check", "audit:boundaries", "packages:check", "scripts:test", "mac:build-test", "docs:verify"],
        cache: false,
      },
    },
  },
  // scripts/'s own tests; each package has its vite.config.ts with its own.
  test: { include: ["scripts/**/*.test.ts"] },
  // The pre-commit hook (.vite-hooks/pre-commit) runs these on the staged files.
  staged: { "*": "vp check --fix --deny-warnings" },
  fmt: {
    printWidth: 160,
    // Generated files and data keep their source format; docs keep their compact tables.
    ignorePatterns: [
      "**/*.md",
      "**/*.gen.ts",
      "**/testdata/**",
      "assets/**",
      ".agents/**",
      "design/**",
      "crates/**",
      "apps/mac/ui/build/**",
      "apps/mac/ui/build-shell/**",
      "apps/mobile/build/**",
    ],
    // Imports from farthest to nearest: Node, packages, the workspace's own, this app's #/, then the same folder.
    sortImports: {
      customGroups: [{ groupName: "workspace", elementNamePattern: ["@vibevalley/**"] }],
      groups: ["builtin", "external", "workspace", ["internal", "subpath"], ["parent", "sibling", "index"], "style", "unknown"],
    },
  },
  lint: {
    ignorePatterns: [
      "crates/**",
      ...(hasNshTypes ? ["apps/mac/ui/.nsh/**", "apps/mac/ui/build/**", "apps/mac/ui/build-shell/**"] : ["apps/mac/ui/**"]),
      ...(hasMobileNshTypes ? ["apps/mobile/.nsh/**", "apps/mobile/build/**"] : ["apps/mobile/**"]),
    ],
    // oxlint's defaults and import for no-cycle; listing plugins replaces the defaults.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "vibevalley", specifier: "./scripts/audit/oxlint-plugin.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "vibevalley/no-comment-divider": "error",
      // A package reaches another only by its name (scripts/audit/oxlint-plugin.ts, no-cross-package-path).
      "vibevalley/no-cross-package-path": "error",
      // [...text] splits by code point, on purpose (docs/style/code.md).
      "typescript/no-misused-spread": "off",
      // A copy before changing what is iterated, on purpose.
      "unicorn/no-useless-spread": "off",
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
      // Plain async code awaits in loops all the time (a transaction's writes, an ordered shutdown); steps that could run
      // together are written with Promise.all (.agents/skills/vv-typescript), not caught by a rule that needs a comment on every loop.
      "eslint/no-await-in-loop": "off",
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
        // Shipped code lets no any through: what JSON, a library or a cast gives untyped is typed where it comes in.
        // Tests and scripts read JSON they wrote themselves.
        files: ["apps/*/src/**", "apps/mac/ui/**", "packages/*/src/**"],
        rules: {
          "typescript/no-unsafe-argument": "error",
          "typescript/no-unsafe-assignment": "error",
          "typescript/no-unsafe-call": "error",
          "typescript/no-unsafe-member-access": "error",
          "typescript/no-unsafe-return": "error",
        },
      },
      {
        files: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "apps/mac/ui/**/fixtures/**",
          "apps/mac/ui/**/*.story.tsx",
          "apps/mac/ui/**/story.tsx",
          "apps/mac/ui/**/stories/**",
          "apps/mac/ui/app/fakeHost.ts",
          "apps/mac/ui/infra/polyfill.ts",
          "packages/*/src/testing/**",
          "packages/testkit/src/**",
        ],
        rules: {
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
      {
        // nsh 0.6.0's generated `test.d.ts` types `test(name, body: () => void)` without `Promise<void>`, so async tests fire no-misused-promises.
        files: ["apps/mac/ui/**/*.test.ts", "apps/mac/ui/**/*.test.tsx", "apps/mobile/**/*.test.ts", "apps/mobile/**/*.test.tsx"],
        rules: { "typescript/no-misused-promises": "off" },
      },
      {
        // A test's cast is checked by the test: a wrong claim fails the expectation that reads it.
        files: [
          "**/*.test.ts",
          "**/*.test.tsx",
          "apps/*/test/**",
          "apps/mac/ui/**/fixtures/**",
          "apps/mac/ui/**/*.story.tsx",
          "apps/mac/ui/**/story.tsx",
          "apps/mac/ui/**/stories/**",
          "apps/mac/ui/app/fakeHost.ts",
          "packages/*/test/**",
          "packages/*/src/testing/**",
          "packages/testkit/src/**",
        ],
        rules: { "typescript/no-unsafe-type-assertion": "off" },
      },
      {
        // The tests wait on conditions, not on the clock (scripts/audit/oxlint-plugin.ts, no-test-sleep).
        files: ["apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.tsx", "apps/mac/ui/**/*.test.ts", "apps/mac/ui/**/*.test.tsx", "packages/*/src/**/*.test.ts"],
        rules: { "vibevalley/no-test-sleep": "error" },
      },
      {
        // What the shipped code says to the user is in the catalogs (crates/i18n/locales, read as t("key");
        // scripts/audit/oxlint-plugin.ts, no-cjk-literal): Chinese is written only there and in the tests.
        files: ["apps/*/src/**", "apps/mac/ui/**", "packages/*/src/**"],
        rules: { "vibevalley/no-cjk-literal": "error" },
      },
      {
        files: [
          // Written by scripts/gen/i18n.ts gen from the catalogs.
          "packages/i18n/src/catalogs.ts",
          // The site's bilingual marketing copy has its own typed dictionaries.
          "apps/site/src/i18n/**",
          // QuickJS Intl.DateTimeFormat("zh-CN") polyfill formats Chinese calendar tokens.
          "apps/mac/ui/infra/polyfill.ts",
          // Story/demo sample data and test fixtures.
          "apps/mac/ui/**/*.samples.ts",
          "apps/mac/ui/**/*.story.tsx",
          "apps/mac/ui/**/story.tsx",
          "apps/mac/ui/**/stories/**",
          "apps/mac/ui/**/fixtures/**",
          "**/*.test.ts",
          "**/*.test.tsx",
          "packages/*/src/testing/**",
        ],
        rules: { "vibevalley/no-cjk-literal": "off" },
      },
      {
        // Markup takes its looks from `class` (Tailwind utilities, vv-tailwind), never a written-out `style` (style-attrs).
        files: [
          "apps/site/src/**",
          "apps/mac/ui/App.tsx",
          "apps/mac/ui/ShellApp.tsx",
          "apps/mac/ui/app/**",
          "apps/mac/ui/features/**",
          "apps/mac/ui/farm/**",
          "apps/mac/ui/design/**",
          "apps/mac/ui/workspace/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx", "**/*.story.tsx", "**/story.tsx", "**/stories/**"],
        rules: { "vibevalley/style-attrs": "error" },
      },
      {
        // src/base is a package's pure ground (scripts/audit/oxlint-plugin.ts, subpackage-layers).
        files: ["apps/*/src/**", "packages/*/src/**"],
        rules: { "vibevalley/subpackage-layers": "error" },
      },
      {
        // A global is declared once in its door and read with its type (scripts/audit/oxlint-plugin.ts, global-doors).
        files: ["apps/**", "packages/**", "scripts/**"],
        rules: { "vibevalley/global-doors": "error" },
      },
      {
        // The doors: what a page shares with the shell that hosts it, and QuickJS's polyfill surface.
        files: ["packages/protocol/src/host.ts", "apps/mac/ui/infra/polyfill.ts"],
        rules: { "vibevalley/global-doors": ["error", { door: true }] },
      },
      {
        // One word for none (scripts/audit/oxlint-plugin.ts, one-absent).
        files: ["apps/**", "packages/**"],
        // Native Rust vibevalley/rich props accept JSON null or omitted optional fields across the JS bridge.
        excludeFiles: ["apps/mac/ui/infra/rich.ts"],
        rules: { "vibevalley/one-absent": "error" },
      },
      {
        // Native UI layers flow one way: infra -> design -> features -> (app | farm | workspace) (scripts/audit/oxlint-plugin.ts, ui-layer-boundaries).
        files: ["apps/mac/ui/**"],
        rules: { "vibevalley/ui-layer-boundaries": "error" },
      },
      {
        // Shipped code and its tests start no process; scripts do (scripts/audit/oxlint-plugin.ts, child-process-door).
        files: ["apps/**", "packages/**"],
        excludeFiles: ["**/scripts/**"],
        rules: { "vibevalley/child-process-door": "error" },
      },
      {
        // Component views share bucketed clocks instead of spawning per-row timers (scripts/audit/oxlint-plugin.ts, no-component-interval).
        files: ["apps/mac/ui/features/**/*.tsx", "apps/mac/ui/design/**/*.tsx", "apps/mac/ui/workspace/**/*.tsx", "apps/mobile/src/**/*.tsx"],
        rules: { "vibevalley/no-component-interval": "error" },
      },
      {
        // nsh fine-grained reactivity rules (docs/style/nsh-tsx.md; scripts/audit/oxlint-plugin.ts).
        files: [
          "apps/mac/ui/workspace/**/*.tsx",
          "apps/mac/ui/design/**/*.tsx",
          "apps/mac/ui/features/channel/**/*.tsx",
          "apps/mac/ui/features/issue/**/*.tsx",
          "apps/mac/ui/features/runtime/**/*.tsx",
          "apps/mac/ui/features/setting/**/*.tsx",
          "apps/mobile/src/**/*.tsx",
        ],
        excludeFiles: ["**/*.test.tsx", "**/*.story.tsx", "**/story.tsx", "**/stories/**"],
        rules: {
          "vibevalley/nsh-no-jsx-conditional": "error",
          "vibevalley/nsh-no-jsx-map": "error",
          "vibevalley/nsh-each-key": "error",
          "vibevalley/nsh-no-props-destructure": "error",
          "vibevalley/nsh-no-eager-accessor": "error",
        },
      },
    ],
    // A disable comment whose rule no longer fires there is an error, so none outlives its reason.
    options: { typeAware: true, typeCheck: true, reportUnusedDisableDirectives: "error" },
  },
});
