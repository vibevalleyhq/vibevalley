# Agent Note: Adopt StyleX and a prerendered Solid 2 website in one PR

Status: proposed

## Problem

Replace every repository-owned Tailwind consumer with StyleX in one PR. Replace the website's Astro and React stack with Vite and Solid 2 in that same PR. Preserve appearance, content, routes, accessibility, and interactions.

The owner approved a change to the website architecture: static documents with one hydration root per page replace Astro's independently scheduled islands. This supersedes the earlier requirement to preserve `client:idle` and `client:visible`. Do not implement another Astro renderer or add SolidStart.

This is an implementation plan, not a completion claim. The branch is `refactor/tailwind-to-stylex`; its base is `a12ad2ee4f72775d8835a3e1f0c3f6e8a08c7c37`. The production website now uses prerendered Solid 2. Its browser and reduced-motion screenshot checks pass; the repository-wide StyleX conversion and aggregate acceptance remain unfinished.

## Proposal

Use the official StyleX compiler for all CSS consumers and the installed Solid Vite plugin for the website's single-root pre-rendered documents. Complete the rendering and style-boundary gates before converting consumers.

## 道 — Principles and boundaries

1. Preserve business behavior, routes, copy, artwork, themes, accessibility, and the observed animation sequences.
2. Keep one owner for each style value. Keep app tokens in `apps/web/src/style.css` and website tokens in `apps/site/src/styles/global.css`.
3. Keep all apps in the root workspace. Use the root dependency catalog and lockfile; do not restore an isolated site workspace.
4. Use the installed Solid 2 runtime and compiler family. Do not replace Solid 2 with Solid 1 or copy React lifecycle semantics into Solid components.
5. Emit complete static website documents. JavaScript must not be required for content, SEO metadata, fonts, or initial styles.
6. Hydrate each website document once. Visibility may control animation setup and playback, but must not create independent late hydration roots.
7. Use public framework APIs. Do not mutate private hydration globals, fork a compiler, force incompatible peers, or inject production CSS at runtime.
8. Keep `packages/base-ui` unstyled. Keep React in applications that require it, including the native mobile app.
9. Deliver one complete PR. Ordered commits and temporary coexistence are permitted on the unmerged branch, not as the final architecture.

Complete migration means no maintained source or output requires Tailwind, and the website requires neither Astro nor React. It does not mean zero plain CSS. Resets, fonts, tokens, rich-text selectors, pre-hydration scene rules, and externally owned positioning or animation values may remain.

This note uses controlled technical English. **Must** means a requirement, **should** a recommendation, and **may** an option. It does not claim ASD-STE100 certification.

## Scope

| Area | Location | Required result |
|---|---|---|
| Workbench and pixel DOM | `apps/web/src` | Replace Tailwind classes without changing layout, themes, farm/tree overlays, or behavior. Pixi canvas drawing is not a CSS migration. |
| Stories | `packages/stories`, web story sources and builds | Compile package-source styles and preserve theme frames, forced states, and responsive examples. |
| Website | `apps/site` | Replace Astro/React with pre-rendered Solid 2, then replace Tailwind. Keep `/`, `/en/`, and `/404.html`. |
| Animation | Website components and proposed `src/animation/` | Replace React hooks and Motion components with Solid lifecycle and DOM animation APIs. |
| Component boundaries | Styled UI, Base UI consumers, public styling props | Preserve forwarded attributes, refs, focus, event handlers, and positioner styles. |
| Enforcement | Root Vite configuration, lint, token checks, dependency scans | Enforce the new style contracts and reject removed dependencies. |

The initial text scan found class-bearing source in 198 web files, 12 website files, and two stories-viewer files. These are review candidates, not a complete Tailwind inventory. Constants, HTML builders, CSS directives, scene data, and generated output also need classification.

## 器 — Build and verification tools

### Website rendering

Use `@solidjs/vite-plugin` with `ssr: true` and its documented `start` mode. This is the installed Vite plugin's entry generation, not a SolidStart dependency. It emits a client bundle and a server handler with `handleRequest(Request)`.

Use the handler at build time to render the three website paths. Write the complete responses to static HTML files beside the client assets. Publish only that static directory; do not deploy a Node server or the rendering bundle.

- Use a shared Solid document for language, title, metadata, and hydration bootstrap.
- Derive the initial route and language identically on the server and client.
- Use complete, awaited rendering rather than shipping async fallback markup that requires scripts to fill it.
- Fail the build on a failed response, wrong content type, incomplete document, missing route, or missing asset.
- Keep navigation as document links. An SPA router is not needed for three static paths.
- Let the plugin resolve the client manifest and emit CSS/script links. Do not maintain a second manifest resolver.
- Keep font subsetting and share-card generation. Replace Astro image conversion with a build-time asset step; do not duplicate original artwork.
- Preserve canonical URLs, alternate-language links, sitemap, robots, response headers, and Cloudflare static publishing.

The website uses the root TypeScript toolchain. Astro, its TypeScript 6 catalog and astro2tsx package extension have been removed. Motion is used through its DOM entry; package-manager overrides remove its unused optional React adapters rather than forcing incompatible peers.

### StyleX

Use the official `@stylexjs/stylex` runtime and `@stylexjs/unplugin` compiler first. Verify compatibility against the installed versions before bulk conversion.

The production compiler must extract CSS for the app, stories, and website. It must see imported workspace package source, lazy modules, and SSR paths. No client-only rendering or runtime style injection may substitute for extracted initial CSS.

Keep existing token values and theme scopes. Use typed references to existing CSS custom properties rather than creating a second palette. Define CSS layer order explicitly. Replace Tailwind's reset and implicit defaults before removing its plugin.

Use `stylex.attrs()` at Solid DOM boundaries. Its serialized `style` string is not interchangeable with a style object. Base UI positioners merge object styles: use a narrow, tested styled boundary that preserves their positioning values without adding StyleX to Base UI.

### Machine-readable completion

Completion tooling:

- `scripts/style-migration.ts`, exposed as `migration:inventory`: source/parser coverage, dependency inspection, build-graph provenance and output checks. The scanner has regression tests; the complete inventory must still be brought to zero findings.
- `scripts/style-migration-visual.ts`, exposed as `migration:visual`.
- `migration:verify`, which derives the aggregate verdict from fresh reports and behavior checks.

The reports are `inventory.json`, `visual.json`, and `acceptance.json`. A report must identify its schema version, source revision and dirty-source digest, tool versions, relevant lockfile hash, build provenance, inputs, findings, and status. A missing report or failed subprocess must fail the aggregate command.

#### Inventory contract

Enumerate maintained files independently of the scanner. Record paths and hashes, parser coverage, and explicit non-style classifications. Inspect all manifests, the root catalog and lockfile, resolved dependencies, client module graphs, and fresh production output.

Count forbidden findings by category:

- Tailwind dependencies, compiler integrations, directives, class sorting, utilities, and `--tw-*` output composition.
- Unconverted class expressions, constants, templates, helper functions, and styled component contracts.
- Astro runtime/build dependencies and Astro source in the target website.
- React imports, React-specific Motion APIs, and required React modules in the website client graph.
- Missing files, unparsed expressions, incomplete graphs, and stale build inputs.

Use syntax-aware analysis where expressions require it. Unknown expressions are failures, not zero findings. Maintain a closed list of permitted semantic classes. Distinguish negative fixtures, historical prose, optional peer metadata, and genuine shipped dependencies without subtracting findings after counting. Do not exempt whole component directories.

React checks apply only to the website; mobile React is permitted. Empty scans, missing source roots, skipped entries, and unavailable graph data must not pass.

#### Visual contract

Compare the base and candidate with identical fixtures and environments. Fix viewport, device scale, browser version, fonts, locale, timezone, clock, theme, route, scroll position, reduced-motion preference, and interaction sequence.

For application screens, create data through an isolated real server. Preserve and restore the same database, files, IDs, text, order, timestamps, and attachments for both sides. Do not compare two independently randomized farms or hand-build replacement state frames.

Run baseline A/A captures first. Reject unstable scenarios before comparing the candidate. Default tolerance is zero changed pixels. Do not loosen thresholds, hide differences with broad masks, or rewrite baselines to make a failure pass. Record expected, executed, failed, and skipped scenarios; missing or skipped required scenarios fail verification.

Cover both app themes, representative component states, farm/tree DOM overlays, stories, website languages, desktop/mobile widths, all four scene states, and reduced-motion behavior. Save baseline, candidate, and diff images with per-scenario measurements. If images have different dimensions, report a failure rather than comparing only their overlap.

A screenshot does not prove keyboard behavior, cleanup, hydration identity, or animation interruption. Include behavior results in `acceptance.json`; do not infer them from pixel equality.

## 术 — Implementation sequence

### 1. Record immutable baselines and inventory

Complete the source and output inventories before broad style changes. Record every style producer, inherited reset/default, token scope, animation owner, and caller-supplied style contract. Capture the baseline scenario manifest and A/A evidence.

A temporary relocation probe already exists, but it is not the full migration suite.

### 2. Prove pre-rendered Solid 2

Build a minimal production fixture through the same Vite plugin and static-output function intended for the website. Test without a development server:

1. All three routes contain content and extracted CSS without JavaScript.
2. Hydration retains visible and offscreen DOM nodes, child nodes, unique IDs, and input typed before JavaScript loads.
3. State updates preserve independent component state.
4. Conditional children appear correctly, dispose listeners, and remount with fresh state.
5. Language links load another complete document and hydrate it successfully.
6. Build and render failures fail the command; no fallback output is accepted as a successful build.

Do not change private hydration flags. The single root must eliminate the delayed multi-root path by architecture, not suppress its failure.

### 3. Prove StyleX boundaries

Build a changing Solid variant, a dynamic CSS value, a forwarded ref, a positioned Base UI popup, a package-source story, and a pre-rendered website component. Verify first-paint CSS without JavaScript, production extraction, client updates, and type/lint coverage. Test positioning and keyboard focus separately from appearance.

Stop bulk conversion if either compiler or rendering gate fails.

### 4. Convert website behavior while retaining Tailwind

Convert the document, route selection, shared components, and each section to Solid 2. Keep the old appearance and CSS during this phase. Replace Astro asset conversion, static-page generation, and metadata generation. Switch the production build only when the actual website passes browser and screenshot comparisons.

Keep Solid props reactive; do not destructure them or apply React hook assumptions. Use `onSettled` and cleanup for browser subscriptions. Remove obsolete Astro adapter code and its tests when the single-root replacement has passing coverage. Name the superseded regression in the PR rather than making its assertion weaker.

Build only a site-local animation layer until another real consumer needs it. Proposed contracts are `createScrollAnimation`, `createReveal`, `createPresence`, and `createImageTransition`. Use Motion DOM or browser APIs for interpolation and scheduling; do not clone React Motion's full component API.

The layer must own cancellation, listener/observer disposal, reduced-motion behavior, exit lifetimes, interrupted reopening, and focus return. Animation and StyleX must not write the same inline property. Separate elements when two transforms require independent owners.

Verify Hero parallax and scene transitions, How's scroll narrative, Screens' image open/close and shared-element equivalent, Start's copied-label transition, and Bar's behavior. Test fast reverse scrolling, repeated open/close, resize, offscreen pause, and unmount. A static fallback alone is not animation equivalence.

### 5. Convert styles in ordered batches

Convert shared UI contracts first, then consumers, stories, pixel DOM, and website components. Replace class-string composition with local StyleX definitions and explicit typed variants. Do not mechanically put utility strings into inline styles or add a general Tailwind compatibility helper.

Preserve public component behavior, CSS precedence, data/ARIA selectors, pseudo states, media rules, and inherited defaults. Update each affected component story. Run the narrowest behavior and visual checks after each batch.

### 6. Remove obsolete paths and verify the whole result

Remove Tailwind plugins, dependencies, directives, class sort settings, and obsolete style helpers. Remove Astro, its renderer experiment, React website dependencies, and `motion/react` imports. Retain Motion only if its DOM API is used. Remove temporary catalog entries and obsolete lockfile records through the package manager.

Run root checks, targeted tests, `web:check`, website checks/build/browser tests, `deadcode`, and `docs:verify`. Run the three migration verification entries. Require complete inventory coverage, zero forbidden findings, stable visual comparisons, and passing behavior checks.

Update design rules, web and site READMEs, the app/site/foundation subsystem documents, Base UI and stories contracts, and root instructions. Remove this Note after the completed decisions are documented. Open one PR with evidence and explicit unverified items.

## Execution evidence

### Workspace relocation

The website is now in `apps/site` and shares the root workspace, catalog, and lockfile. Root formatting, lint, type, and dead-code checks include it. A catalog regression rejects nested workspace and lock files.

The relocation passed frozen-lockfile installation, `vp check`, `web:check`, site check/build, 333 script tests, `deadcode`, and `docs:verify`.

A scratch probe rebuilt the base revision and compared `/`, `/en/`, and `/404.html` at widths 1440 and 390 with reduced motion. All six A/A and before/after full-page comparisons have zero changed pixels and identical body text. Evidence: `apps/site/.test/workspace/visual.json`; scratch script: `/tmp/vv-site-workspace-visual.mjs`. This proves relocation only, not the framework or styling migration.

### Rejected Astro adapter route

The official `@astrojs/solid-js@7.1.2` uses removed Solid 1 exports. A local public-API adapter passed five browser tests but failed `regression: visible islands hydrate later without replacing their DOM`. After the first island completed, the installed Solid 2 runtime sent a later `hydrate()` call through client rendering.

The owner chose a single-root website instead of retaining Astro. Preserve this failed result as decision evidence; do not report the old multi-root behavior as fixed.

### Single-root production fixture

`vp run --filter @vibevalley/site test:prerender` builds client and server bundles, renders three static documents, and serves only their static output on an isolated localhost port. The six browser tests pass, including `regression: one hydration root preserves both visible and offscreen server DOM`.

Evidence: `apps/site/.test/prerender/results.json`. Its minimal static writer is `apps/site/scripts/prerender.ts`.

### Production Solid website

The production routes use `Document.tsx`, `App.tsx`, and Solid components. Build-time Sharp processing replaces Astro assets; only `dist/client/` is published. A website-local animation layer owns subscriptions, entering/exiting content, screenshot expansion and cleanup.

All 18 production browser checks pass across ordinary-motion desktop and reduced-motion mobile: static routes, initial CSS/fonts/metadata, hydration identity, modal focus and exit interruption, clipboard confirmation, all four hours, offscreen pause, resizing the narrative, and document navigation. Evidence: `apps/site/.test/production/results.json`.

All six base A/A and before/after full-page comparisons have zero changed pixels and identical body text for `/`, `/en/`, and `/404.html`, widths 1440 and 390. Both sides use the same scroll tour and settling period before capture; island initialization is not used as the candidate's interaction sequence. Evidence: `apps/site/.test/solid/visual.json`; scratch runner: `/tmp/vv-site-solid-visual.mjs`. This is reduced-motion website evidence, not complete migration acceptance.

The official StyleX compiler extracts the website section and heading styles, the workbench Button variants, and shared stories glyphs. Explicit CSS layer declarations preserve precedence during coexistence. The Base UI positioner adapter keeps StyleX runtime variables in object styles; a production browser regression verifies dynamic width, reactive variants, forwarded refs, keyboard focus, positioning and ancestor markers in both themes.

`vp run migration:visual:static --baseline <clean-original-worktree>` rebuilds both sides and records source digests, output hashes, browser identity and fixed capture settings. All 26 scenarios pass baseline A/A and candidate comparisons with zero changed pixels and equal text: six website pages and Button, Field and Tabs frames in two themes and two widths. Evidence: `.test/style-migration/visual-static.json`. The report explicitly excludes live workbench, farm/tree DOM, desktop/mobile hosts and interactive website states; it is not aggregate acceptance.

The source/dependency scanners and exact pixel comparator have 33 passing tests. Dependency classification distinguishes oxfmt's optional Astro parser from website framework dependencies, without exempting a parser with another consumer. Inventory still fails on remaining Tailwind and incomplete or stale build evidence.

## Alternatives considered

- **Keep Astro with a local Solid renderer:** rejected by the owner after the delayed multi-root hydration failure. Do not keep this adapter as a second production route.
- **Use SolidStart:** unnecessary for three static paths. The installed Vite plugin already generates the public SSR/client entries required by the static writer.
- **Use a client-rendered SPA:** rejected because content and initial styles must exist without JavaScript.
- **Patch private Solid hydration state:** rejected because it creates a runtime compatibility contract outside public APIs.
- **Migrate only the workbench:** incomplete; stories, pixel DOM, and the website also consume Tailwind.

## Risks

- Solid 2 and its compiler are prereleases. Keep their versions aligned and run the production hydration tests on upgrades.
- A single root may load more JavaScript before interaction than separately scheduled islands. Measure the client graph and startup cost; retain visibility-controlled animations without reintroducing late hydration roots.
- Motion's shared-element and exit behavior may not have a direct Solid equivalent. Verify interruption, focus, cleanup, and reduced-motion behavior before accepting a replacement.
- CSS extraction, layer order, resets, and positioner style merging can change layout without a type error. Keep first-paint, screenshot, and interaction gates separate.
- The build-only server bundle must not be published with static output. Publishing configuration and output inventory must verify that boundary.
- A failed migration cannot be hidden by changed baselines, weaker assertions, or omitted scenarios. Investigate the mismatch before proceeding.

## Acceptance criteria

- [x] The website belongs to the root workspace at `apps/site`.
- [x] A real Vite + Solid 2 production fixture preserves static content, extracted CSS, DOM identity, input, interactions, and cleanup.
- [x] The production website uses one Solid root per document and no Astro or React.
- [ ] Asset generation, metadata, languages, routes, publishing, and animation behavior match the approved contracts.
- [ ] App, stories, and website use extracted StyleX styles and require no Tailwind.
- [ ] Inventory coverage is complete and forbidden findings are zero.
- [ ] Fixed-input visual comparisons are stable and meet the zero-difference gate.
- [ ] Required behavior checks pass and the aggregate JSON report derives a passing verdict.
- [ ] Documentation is current, obsolete paths are removed, and the work is delivered in one PR.

## Not complete

- Complete inventory findings cleanup, the full scenario manifest, immutable application fixtures, and aggregate JSON runner.
- Remaining lazy-module, host and animation boundary coverage.
- Complete website animation and publishing acceptance beyond the existing production browser checks.
- Repository-wide style conversion and dependency removal.
- Full visual and behavior acceptance, PR, and merge.

## References

- [Architecture](docs/architecture.md), [foundation](docs/subsystems/foundation.md), [site](docs/subsystems/site.md).
- [Website README](apps/site/README.md), [web README](apps/web/README.md), [design rules](docs/style/design.md).
- [StyleX LLM resources](https://stylexjs.com/docs/llm-resources/).
- Installed Solid guidance: `apps/site/node_modules/solid-js/skills/solid-2.0/SKILL.md` and `apps/site/node_modules/solid-js/CHEATSHEET.md`.
- Installed Vite plugin SSR/start-mode contract: `apps/site/node_modules/@solidjs/vite-plugin/README.md`.
