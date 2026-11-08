# Agent Note: Adopt StyleX and a prerendered Solid 2 website in one PR

Status: proposed

## Problem

Replace every repository-owned Tailwind consumer with StyleX in one PR. Replace the website's Astro and React stack with Vite and Solid 2 in that same PR. Preserve appearance, content, routes, accessibility, and interactions.

The owner approved a change to the website architecture: static documents with one hydration root per page replace Astro's independently scheduled islands. This supersedes the earlier requirement to preserve `client:idle` and `client:visible`. Do not implement another Astro renderer or add SolidStart.

This is an implementation plan, not a completion claim. The branch is `refactor/tailwind-to-stylex`; its base is `a12ad2ee4f72775d8835a3e1f0c3f6e8a08c7c37`. The production website now uses prerendered Solid 2. Its browser and reduced-motion screenshot checks pass; the repository-wide StyleX conversion and aggregate acceptance remain unfinished.

## Proposal

Use the official StyleX compiler for all CSS consumers and the installed Solid Vite plugin for the website's single-root pre-rendered documents. Complete the rendering and style-boundary gates before converting consumers.

### Startup correction requested during acceptance

The owner reports repeated loading screens and asks for simulated progress. Desktop currently navigates the visible loading document to another document containing the same loading screen. Keep a single native loading view above the real page across that navigation; the typed host bridge forwards actual loading phases and releases the view only after page readiness or an explicit waiting/error outcome. Browser and phone keep their inline cover. One shared opening script owns visual progress: it advances smoothly below completion while real work is pending, never decreases, stops on failure, and reaches 100% only on actual readiness. Do not add a minimum loading duration. The development launcher must complete its sole watch build before Electron starts.

Acceptance covers an isolated real desktop cold start, refresh, failed server launch, continuous visible progress across the local-to-HTTP handoff, delayed browser readiness, reduced motion, and timeout/error outcomes. Existing desktop and opening regressions cover these behavior boundaries; the full migration receipt follows the correction.

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

Use `stylex.attrs()` at ordinary Solid DOM boundaries. Its serialized `style` string is not interchangeable with a style object and kebab-cases dynamic custom property names in StyleX 0.19.1. At component boundaries that accept caller `StyleXStyles`, merge native `style` objects, or position Base UI elements, use the shared `styleProps()` / `positionerAttrs()` boundary in `apps/web/src/ui/positioner.ts`:

- Evaluate `stylex.props()` once per reactive read, map `className` to Solid's `class`, and preserve dynamic StyleX variables as object styles.
- Place component defaults and semantic tone maps before caller `props.styles` (`styleProps([styles.base, defaultTone, props.styles])`) so explicit caller overrides work predictably.
- Reference semantic tokens (`--color-*`, `--shadow-*`) in component styles rather than theme-internal `--wb-*` primitives.
- Keep shared skin recipes (such as `apps/web/src/ui/pixel/style.ts` typography and chrome) in one `stylex.create` module and compose them at call sites rather than inlining duplicate per-file `recipeStyles` or four-layer `0 0 transparent` ring placeholders.
- Keep owned rich-text CSS (`apps/web/src/ui/Markdown.css` and `apps/web/src/ui/pixel/PxMarkdown.css`) grouped by selector inside `@layer components` and imported through the host stylesheet.

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

## 术 — Quantified backlog and phase TODOs

### Measurement baseline

The remaining-work baseline is commit `ab18831c`, measured with `vp run migration:inventory`. It contains **4,751 class-token occurrences in 151 distinct files**. Occurrences are not unique class names or lines of code. Findings overlap; do not add the rows below into a task total or convert token counts into an estimate of effort.

| Finding | Baseline | Exit condition |
|---|---:|---|
| Files with class tokens | 151 | 0 |
| Class-token occurrences | 4,751 | 0 |
| Styled-contract findings | 23 | 0 unresolved |
| Legacy-helper findings | 10 | 0 |
| Dynamic class findings | 154 | 0 unresolved |
| Unreviewed inline styles | 287 | 0 unreviewed; justified positioning/animation ownership may remain |
| Tailwind CSS findings | 1,290 | 0 |
| Dependency findings | 60 | 0; these are findings, not 60 distinct packages |
| Tailwind imports / configurations | 4 / 1 | 0 / 0 |
| Stale build-input findings | 4 | 0 against final sources |

Dynamic findings are the sum of `unresolved-class-member`, `unknown-class-call`, `unresolved-class-binding`, `unknown-class-expression` and `unknown-class-template`. Generated CSS and dependency counts depend on build freshness and must be reported separately from source conversion. A previous intermediate scan had 6,538 class tokens: the reduction to this baseline is 1,787 (27.3%). That scan was already after migration started, so neither 27.3% nor its complement is an overall completion percentage.

| Area | Baseline tokens | Baseline files | Phase |
|---|---:|---:|---|
| `apps/web/src/ui` | 800 | 34 | 1 |
| `apps/web/src/app` | 49 | 2 | 1 |
| `apps/web/src/stories` | 57 | 6 | 1 |
| `packages/base-ui` | 1 | 1 | 1; classify without styling Base UI |
| `apps/web/src/features` | 2,269 | 61 | 2 |
| `apps/web/src/farm` | 846 | 28 | 3 |
| `apps/web/src/tree` | 85 | 2 | 3 |
| `apps/site` | 361 | 12 | 4 |
| `packages/stories` | 66 | 2 | 4 |
| `design` | 207 | 2 | 4 |
| Other `apps/web` files | 10 | 1 | 4 |

The baseline stays fixed. Update the execution ledger after each verified batch with before/after counts, touched areas, checks and remaining blockers. The inventory JSON is the current machine-readable source; unknown areas and categories must remain visible. Fewer findings do not establish visual or behavioral acceptance. Do not shrink the scanned scope to improve progress.

### Validation cadence

The owner requested larger implementation batches rather than repeated full acceptance after each small conversion. During phases 1–5:

- Run type/lint and the affected production compiler after a substantial batch. Use AST comparison for mechanical conversions and focused unit tests for changed tooling or rules.
- Probe a new compiler mechanism or style boundary once before bulk use. On a failure, reproduce and fix the narrow case; do not repeatedly run unrelated suites.
- Update source counts and the ledger per batch. An implementation checkpoint may be committed with acceptance explicitly pending; it is not an accepted phase or an overall completion claim.
- Defer repeated full visual captures, full browser integration, live screenshot tours and host checks until the phase 6 acceptance pass, after phases 1–5 implementation is complete. The final gates and zero-pixel threshold do not change.

The 170-scene full capture was interrupted at the owner's request while still running. It has no complete accepted receipt and must not be resumed as a claimed pass from its partial log. The interrupted runner has exited. Rebuild and capture against final sources in phase 6.

### Phase 0 — Make progress reproducible

- [x] Record a fixed source baseline, units, disjoint area totals and final exit conditions in this Note.
- [x] Add area/token/distinct-file summaries to the existing inventory command and JSON without changing its acceptance verdict.
- [x] Test repeated occurrences, overlapping findings, unknown areas/categories, path boundaries, deterministic ordering and reconciliation of totals.
- [x] Run the inventory and record the first ledger row; expected verdict remains failed while migration is incomplete.

### Phase 1 — Close shared styling contracts (907 tokens / 43 files at baseline)

- [x] Locate all 23 contract findings and 10 helper-call findings in the scanner output; record their ownership below. These are findings, not 23 confirmed public APIs or 10 distinct helper functions.
- [x] Trace each baseline contract's callers and distinguish actual style APIs, story data and native/externally owned attributes before converting or classifying it. The string-contract finding category is zero; remaining native interfaces and dynamic class producers still require review.
- [x] Convert workbench layout, status/icon/avatar and remaining UI contracts with all callers in the same batch. Start with `apps/web/src/ui/layout.tsx` (100 token occurrences at baseline).
- [x] First layout slice: replace Card's class-string prop with typed StyleX composition and migrate all six skill/voice callers; preserve dynamic variables as object styles. Split, ListCard, ListRow, Toggle, SecretInput and TextLink are also converted; their consolidated acceptance is pending phase 6.
- [x] Convert pixel component contracts, starting with `apps/web/src/ui/pixel/choice.tsx` (88 occurrences); keep positioning and animation values under one owner.
- [x] Convert remaining app shell and web story styles; change each affected component's story alongside its API.
- [x] Resolve the Base UI finding without introducing styles into the unstyled package.
- [ ] Add coverage for dynamic object variables, refs, focus, disabled/data states and responsive composition. Reuse the proven boundaries during bulk conversion; execute the complete component/visual acceptance in phase 6.

### Phase 2 — Convert business pages (2,269 tokens / 61 files at baseline)

- [x] Channel: message parts (134 occurrences), message list (109), sidebar (102), and their remaining consumers.
- [x] Agent, runtime and connector: start with `AgentsPage.tsx` (115 occurrences).
- [x] Issue: detail, lists, board, completion and queued-work surfaces; preserve all state-specific layouts.
- [x] Artifact: start with `ArtifactsPage.tsx` (107 occurrences); include document, HTML sandbox, versions and reply controls.
- [x] Memory, orchestrator, repository, settings, inbox, knowledge and pairing: cover remaining inventory findings; start memory with `Memory.tsx` (86 occurrences).
- [ ] Keep relevant domain integration tests and populated fixture scenarios current as callers change. Run their complete acceptance and isolated-server desktop/390px inspection in phase 6; empty states alone cannot close populated acceptance.

### Phase 3 — Convert farm and tree DOM (931 tokens / 30 files at baseline)

- [x] Farm issue surfaces: start with `farm/issue/IssueView.tsx` (163 occurrences).
- [x] Farm chat: start with `farm/chat/Messages.tsx` (157 occurrences).
- [x] Remaining farm overlays, dialogs, panels and responsive DOM; do not change Pixi drawing or game/business rules.
- [x] Tree panels and overlays; retain artwork, motion ownership and keyboard interactions.
- [ ] Verify populated states, both themes where supported, narrow/desktop geometry and reduced motion against the original baseline.

### Phase 4 — Finish website, viewer and remaining containers (644 tokens / 17 files at baseline)

- [x] Website Hero (167 occurrences): hour-dependent visibility, pressed controls, responsive layout and pre-hydration rules.
- [x] Remaining website sections and animation-related style boundaries; no property may have both Motion and StyleX writers.
- [x] Viewer filled-frame descendant contract and remaining layout classes; keep the identical catalogue fixture on both sides.
- [x] Design HTML and other web containers; migrate or justify each finding, not entire directories.
- [ ] Verify all three routes without JavaScript, metadata/assets/fonts, hydration identity, four hours, reverse scrolling, modal interruption/focus, resize, offscreen pause, unmount and reduced motion. Keep the single-root public-API architecture.

### Phase 5 — Remove Tailwind and enforce StyleX

- [x] Make design-token lint understand StyleX; test valid and invalid declarations before deleting utility-based enforcement.
- [x] Resolve all dynamic expressions and review inline ownership; each retained semantic class or plain-CSS rule needs a narrow classification.
- [x] Preserve required reset, font, token, rich-text and pre-hydration defaults independently of utility discovery.
- [x] Remove Tailwind plugins, dependencies, directives, class sorting and obsolete helpers; regenerate the root lockfile through the package manager.
- [ ] Rebuild app, stories and site client/SSR outputs; require complete inventory coverage and zero forbidden findings. Do not treat a missing or stale graph as zero work.

### Phase 6 — Complete acceptance and deliver one PR

- [ ] Finish immutable real-server fixture creation/restoration, including IDs, times, attachments and populated state; cover lazy modules, themes and interactions.
- [ ] Complete the full canonical visual manifest with stable A/A and zero changed pixels. The interrupted 162-scene run is not an accepted receipt.
- [ ] Complete desktop/mobile host, website animation and publishing checks; publish only the static client directory.
- [ ] Implement `migration:verify`: derive its verdict from fresh inventory, complete visual/behavior receipts and required scenarios; fail on missing, stale, failed or skipped evidence.
- [ ] Run final root, web, site, dead-code and documentation checks. Keep workflows unchanged.
- [ ] Document lasting contracts in subsystem/package documentation, remove this proposed Note only after completion, and deliver one PR with evidence and explicit unverified items.

### Contract triage queue

| Owner | Baseline contract findings | Definition files | Next action |
|---|---:|---|---|
| Workbench UI | 5 | `Checkbox.tsx`, `Form.tsx`, `Markdown.tsx`, `Tag.tsx`, `layout.tsx` | These baseline contracts and their callers are migrated; finish remaining literal styles and phase 6 acceptance |
| Pixel UI | 9 | `PxMarkdown.tsx` (2), `base.tsx` (3), `dialog.tsx` (1), `field.tsx` (3) | All baseline contracts are migrated; remaining literal styles and phase 6 acceptance are open |
| Token stories | 1 | `ui/tokens.stories.tsx` | Curve and token data use typed styles / CSS-variable references; labels are unchanged |
| Business features | 5 | `issue/Sheet.tsx` (1), `session/WorkLog.tsx` (1), `voice/DictationButton.tsx` (3) | All baseline contracts and explicit callers migrated; phase 6 acceptance pending |
| Farm | 2 | `farm/map/RepoMap.tsx`, `farm/panels/rows.tsx` | Art and Tinted compose styles while retaining native geometry and color ownership |
| Tree | 1 | `tree/TreePanel.tsx` | Filters and its placement caller migrated; remaining overlay styles are open |

The ten baseline helper-call findings are in website `Bar.tsx` (1) and `Hero.tsx` (3), and pixel `PxMarkdown.tsx` (2), `button.tsx` (1) and `field.tsx` (3). Field's three calls and PxMarkdown's two calls are removed; five findings remain. Definitions must be removed only after all callers are migrated. All baseline string-contract findings are resolved, reducing that category from 23 to zero. Additional native-attribute interfaces (TextInput, TextArea, SecretInput and Icon) were migrated as well, but were not counted in that baseline category. Split/ListCard/ListRow, Toggle and TextLink are converted. Next are the remaining ordinary/pixel literals, relational selectors, animations and native-style ownership. The queue is not an exemption list. Contract batches include all callers even when those callers belong to a later phase.

### Execution ledger

| Batch | Before → after tokens / files | Evidence | Status |
|---|---|---|---|
| Quantified baseline (`ab18831c`) | 4,751 / 151 | Inventory; source conversion and final acceptance still open | Recorded |
| Phase 0: reproducible progress; phase 1: definition census | 4,751 / 151 → 4,751 / 151 | 37 scanner/dependency/pixel/progress tests pass; inventory emits reconciled area totals and still fails on remaining findings | Phase 0 complete; no style-conversion reduction claimed |
| Phase 1: Card and six skill/voice callers | 4,751 / 151 → 4,739 / 151 | Contract findings 23 → 22; 18 component and 13 focused integration tests; 4 exact Card comparisons; 26 web-check tasks | Verified slice; phase 1 remains open |
| Shared list layouts and closed native variants across phases 1–3 | 4,739 / 151 → 3,457 / 135 | 223 expressions in 85 mechanically converted files retain their non-styling AST; 19 component and 167 integration tests pass; 26 web-check tasks pass | Full capture interrupted at owner's request; acceptance deferred to phase 6; contracts remain 22 |
| Phase 1: Tag/Dot, Checkbox and Form contracts | 3,457 / 135 → 3,412 / 131 | All private class callers migrated; contract findings 22 → 19; clean type/lint and production stories compilation | Implementation checkpoint; browser and pixel acceptance deferred to phase 6 |
| Phase 1: text controls, remaining layout controls and Icon | 3,412 / 131 → 3,273 / 125 | 25 text-control and 31 Icon call sites migrated; clean 1,295-file type/lint and production stories compilation; non-styling AST comparison passes for 28 caller files | Implementation checkpoint; 19 contract findings remain; new browser tests and full visual acceptance pending phase 6 |
| Phase 1: Markdown, IconButton and Chips | 3,273 / 125 → 3,199 / 123 | Markdown's two callers migrated; its 40 descendant utility rules become owned rich-text CSS; IconButton and Chips use StyleX; contract findings 19 → 18 | Implementation checkpoint; browser and visual acceptance pending phase 6 |
| Cross-phase mechanical sweep: constants, maps and independent conditions | 3,199 / 123 → 2,021 / 108 | 229 expressions across 53 files; non-styling AST comparison passes; clean type/lint and production stories compilation | Implementation checkpoint; 18 contract findings remain; full acceptance pending phase 6 |
| Pixel contracts, alpha fallbacks and remaining simple native patterns | 1,968 / 102 → 1,686 / 95 | Fresh working-tree starting scan; contract findings 18 → 11; 19 native expressions / 14 files and 9 caller expressions / 5 files; core and native non-styling AST proofs; 38 migration unit tests | Committed as `f54f809f`; browser and complete visual/live/host acceptance pending phase 6 |
| Remaining string contracts, pixel rich text and token data | 1,686 / 95 → 1,544 / 92 | Contract findings 11 → 0; helpers 7 → 5; 12 mechanical caller expressions / 7 files; non-styling AST proof across 13 files; original rich-text declarations preserved in 25 scoped CSS rules | Implementation checkpoint; native boundaries, remaining classes and full acceptance still open |
| Parallel source convergence across phases 1–5 | 985 / 62 → 0 / 0 | 214 expression-specific native ownership reviews; 353 tooling/lint tests pass; app, stories and site production compilers pass; refreshed inventory scans 2,839 files with only four stale-build-input findings after tooling/document edits | Source implementation complete; final formatted builds, full pixels, behavior and native hosts remain required |

Card live inspection covers the new-skill and voice configuration forms at 1440×900 and 390×844. Desktop receipt: `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-IR07mx/result.json`. Narrow receipt: `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-bjJzVX/result.json`. Both record code 0, stopped true and no cleanup errors. The default narrow navigation leaves the cards below the fold; the inspected narrow card captures use the real settings-search control to filter navigation and then scroll to the card. This is scoped form evidence, not a default-state full-page comparison or final populated-data acceptance.

The rendering and conversion constraints below remain prerequisites for each phase, not a second completion checklist.

## Migration prerequisites

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

Preserve public component behavior, CSS precedence, data/ARIA selectors, pseudo states, media rules, and inherited defaults. Update each affected component story. Follow the validation cadence above: use lightweight batch checks during implementation and consolidate full behavior and visual acceptance in phase 6.

### 6. Remove obsolete paths and verify the whole result

Remove Tailwind plugins, dependencies, directives, class sort settings, and obsolete style helpers. Remove Astro, its renderer experiment, React website dependencies, and `motion/react` imports. Retain Motion only if its DOM API is used. Remove temporary catalog entries and obsolete lockfile records through the package manager.

Run root checks, targeted tests, `web:check`, website checks/build/browser tests, `deadcode`, and `docs:verify`. Run the three migration verification entries. Require complete inventory coverage, zero forbidden findings, stable visual comparisons, and passing behavior checks.

Update design rules, web and site READMEs, the app/site/foundation subsystem documents, Base UI and stories contracts, and root instructions. Remove this Note after the completed decisions are documented. Open one PR with evidence and explicit unverified items.

## Execution evidence

### Remaining string contracts and pixel rich text

Sheet Note, WorkLog, the three dictation wrappers, farm Art/Tinted, tree Filters, PxMarkdown/PxReadText and the Curve story now accept typed styles with their callers. Native geometry and color objects retain their original priority. WorkLog draws the original top/bottom run separators on its direct run elements. The redundant `p-3` on one Tinted caller is removed because the original `px-3 py-2` won in production CSS; Note's important padding becomes a composed caller override without retaining an important utility.

Dictation owns its pulse keyframes and reduced-motion branch. The workbench caller uses the explicit surface-hover variant: merging an external hover-only background recipe would clear the recording fill, so the component owns each complete background state. Pointer hold/tap timing and recorder lifetimes are unchanged.

Pixel rich text keeps parsing, sanitization, mentions, links, cleanup and retained DOM nodes. Descendant utility declarations come from the immutable original stylesheet, folded in original order into `PxMarkdown.css`: 33 expanded selectors/conditions grouped into 25 rules. Reading-mode conditions use zero-specificity `:where` so their scope does not raise selector specificity. The stylesheet enters through `style.css`; the root, inserted links/mentions/separators and plain-text clamp use StyleX. `/tmp/vv-contracts-css-proof.json` verifies the grouped declaration maps against the extracted rules. Token stories use CSS-variable references and typed typography while keeping their displayed labels and curve measurements.

The caller converter changes twelve expressions in seven files. `/tmp/vv-contracts-proof.json` compares thirteen implementation/token-story files against `f54f809f`, preserving non-style AST and independently checking token labels; new stories/tests are outside that proof. Type/lint, application and stories production builds, 38 migration unit tests and dead-code checks pass. The sixteen pixel-kit/session-run tests also pass, but their runner reports a close timeout for two Vite servers before exiting successfully; the cause is not established and no timeout was changed. The production CSS probe retains the expected layer order. Three new browser regressions cover rich-text identity/clamps, dictation surface hover and run separators; they remain unrun until phase 6.

The fresh inventory remains failed at 1,544 class tokens / 92 files, five legacy-helper findings and two stale site graphs. Zero string-contract findings is not a claim that all native styling boundaries, dynamic class expressions, retained inline styles or migration acceptance are complete.

### Pixel contracts and malformed color fallbacks

PxWindow, PxFrame, PxCard, DashedLine, PxTip, PxTextInput, PxTextArea and the internal Modal now compose typed StyleX styles with their callers. Window/frame shadows live in `pxStyle`; obsolete string exports are removed. Tree overlays retain their conditional placement and native coordinate objects. Modal backdrops, bounded sizes and starting styles retain reduced-motion branches. The installed compiler was probed for `@starting-style` before use. Textareas retain the original effective typography: the baseline's mono/pixel line-height rules override the extra `leading-[1.625]` utility, despite their order in the class string.

The converter's fixed-color substitution had matched a six-digit color inside an eight-digit alpha color, producing invalid values such as `var(--color-leaf-300)99`. All 23 occurrences across 16 files are replaced with owned complete alpha-color tokens; fallback bytes and existing color-mix support branches are retained. Substitution now requires a complete color match. The inventory rejects malformed variable suffixes, with a regression test that also preserves legitimate content strings.

The remaining native-pattern pass covers prefixed user-selection/decoration/mask declarations, enabled states and starting styles. Nineteen native expressions in fourteen files pass the narrow AST proof (`/tmp/vv-converge-native-proof.json`); nine component caller expressions in five files were converted separately. The seven core/caller implementation files also pass a non-styling AST comparison (`/tmp/vv-converge-core-proof.json`), excluding only style definitions, style imports/attributes/contracts and the typography-reference rename. These file groups overlap. Dead-code cleanup removes the unused channel-header class export and two pixel barrel re-exports.

Type/lint, the production stories build, all 38 migration unit tests, dead-code checks and all nine documentation tasks pass. The production CSS probe (`/tmp/vv-converge-css-proof.json`) finds all thirteen exact alpha-color tokens, no malformed color-variable suffixes, six starting-style rules, and the original `properties → theme → base → components → utilities` layer sequence with StyleX inserted before utilities.

The new composition story and browser regression cover window variables plus native style, input/textarea variables, suggestion keyboard selection, retained input identity, effective line heights and disabled controls. The regression is deliberately unrun until phase 6; compiler and AST checks do not establish browser or pixel acceptance. The source inventory remains failed at 1,686 tokens / 95 files / 11 contracts. The batch starts from a fresh 1,968 / 102 working-tree scan, not the preceding commit's ledger count.

### Cross-phase mechanical sweep

The implementation now proceeds by syntax pattern across phases 1–4, rather than finishing individual components in isolation. The temporary converter resolves static constants, readonly exported maps and their barrel re-exports, static template fragments, and independent conditional class combinations. It enumerates bounded combinations against the original production stylesheet and only separates properties whose values depend on at most one condition. Coupled properties, unresolved calls, mutable/escaped maps and complex selectors remain exceptions. Generated production code contains StyleX definitions and typed lookups, not a runtime utility resolver.

The sweep converts 229 expressions in 53 files: 135 in its first web pass, 80 in the extended web pass and 14 in the stories accessibility panel. The website pass converts none and retains its explicit exceptions. The extended pass supports container queries, reuses fixed owned shadow/color tokens and removes unused Tailwind gradient transition targets only when the converted recipe has no gradient declarations. Original stylesheet order, rather than class-string order, determines the result; for example, the original `leading-[1.3333]` overrides `leading-[1.625]` in the pixel note recipe.

`/tmp/vv-wide-proof.json` restores exactly 229 converted attributes across 53 files, permits only generated styling declarations and removed styling-only constants/imports, and reports no non-styling AST differences. `/tmp/vv-wide-all-check.log` records the clean 1,295-file type/lint check; `/tmp/vv-wide-commit-build.log` records the successful production stories compilation. Inventory remains failed at 2,021 tokens / 108 files / 18 styled-contract findings. Browser, exact visual and host acceptance are still deferred to phase 6. These checks establish an implementation checkpoint, not completed migration acceptance.

### Markdown, icon buttons and chips

Markdown's root and both styled callers use typed StyleX composition through `styleProps`. Its descendant utility rules are scoped to `.markdown` in `apps/web/src/ui/Markdown.css`, grouped by selector inside `@layer components` without Tailwind variables or directives. Parsing, safe links, issue references, mentions, code highlighting and diagram lifetimes are unchanged. The stylesheet is imported through the host stylesheet: importing it from the component hoisted the `components` layer before `base` in the production asset. The compiled first-encounter layer order is now verified as theme → base → components → stylex → utilities (`/tmp/vv-richtext-layer-order.json`); minification may remove a redundant textual prelude, so the check reads semantic layer order rather than a literal prefix.

IconButton retains pressed, danger, hover, active and disabled states through composed styles. ChipsInput and KeyValueEditor retain their handlers and keyed rows while replacing their class-string recipes. Their stories expose keyboard selection and disabled controls. The added browser regressions (text controls, icons, Markdown and icon buttons) remain unrun until phase 6.

The expanded caller AST proof now covers 29 files, with no non-styling differences. Its 155 restored attributes include unchanged styling attributes; the mechanical conversion count is 51 expressions, not 155. The current inventory remains failed at 3,199 tokens / 123 files / 18 styled-contract findings. The canonical visual manifest now has 202 scenes; there is no complete refreshed acceptance receipt.

### Text controls, layout controls and icons

TextInput, TextArea, Select, Button, Checkbox, Form, Card, Dot, Icon and Markdown share the `styleProps` composition helper in `apps/web/src/ui/positioner.ts`, which evaluates `stylex.props()` once per reactive read, maps `className` to Solid's `class`, and preserves object-only inline styles. All 25 explicit text-control class callers moved together; a separate spread audit found only the form-control bindings, the typed SecretInput forwarding and the settings control's narrow attribute Pick. A new story and regression cover camel-cased runtime variables, native inline height, editing, keyboard focus and input identity. The input's horizontal padding has separate physical slots so SecretInput's right padding does not discard its left padding during composition.

Toggle and TextLink now own their styles directly. The toggle thumb's original two-shadow paint is retained in the control-specific `--shadow-toggle-thumb` token. The desktop strip retains its existing semantic `window-drag` CSS for the external Electron drag region; its ordinary layout styles use StyleX.

Icon and its 31 explicit class callers now compose typed styles. Semantic marks retain their fixed tones; a new composition story and regression cover tone precedence and dynamic variables. Dispatch/thread and knowledge-sidebar hover/focus relationships use exported StyleX markers. The outline chevron retains its visible `position: absolute` rest state without a no-op hover display marker: in the original production stylesheet `.inline-flex` followed and overrode `.hidden`, and `position: absolute` already blockifies the element's display box.

Shared pixel typography and chrome (`pxStyle` in `apps/web/src/ui/pixel/style.ts`) are authored once with `stylex.create` and composed in `base.tsx`, `dialog.tsx`, `choice.tsx`, `ToastViewport.tsx`, `field.tsx`, `forms.tsx` and `PixelCard.tsx` rather than duplicated across per-file `recipeStyles`. Component StyleX declarations reference semantic `--color-*` and `--shadow-*` tokens rather than palette-internal `--wb-*` variables, and omit redundant four-layer `0 0 transparent` ring placeholders.

The mechanical tools converted 49 expressions (25 text-control and 24 Icon expressions); the other seven Icon calls were migrated explicitly. The initial caller proof covered 28 files with no non-styling differences. `/tmp/vv-control-callers-proof.json` has since been expanded to include Markdown callers (29 files); its restored styling attributes include unchanged attributes and are **not** a conversion count. Type/lint and production compilation pass; the added browser regressions have not yet been run. This slice expanded the canonical manifest to 190 scenes with the existing layout controls and toggle-state grid; the later Markdown/IconButton/Chips slice brings it to 202. No complete new visual receipt is claimed.

### Status and form contracts

Tag and Dot use typed tone maps. Dot, Checkbox and Form now accept `StyleXStyles`, forwarding runtime variables as objects. Their channel, artifact, issue, settings and story callers are migrated. Dot retains the original five-shadow ring composition; Tag retains the original color-mix support fallback. Checkbox's checked/indeterminate border continues to override hover, matching the original stylesheet order. The component stories include dynamic placement and sizing; the final visual manifest also includes the original Tag states, tones and Dot tones. These changes have type/lint and production-compiler checks only so far; full behavior and visual acceptance is deferred under the revised cadence.

### Closed variants and responsive list layouts

Split, ListCard and ListRow now use local StyleX definitions. Selected rows retain hover precedence through a zero-specificity selected-state selector. The new production regression checks edge borders at the 767/768px boundary, bare/card headers, selected hover and reactive switching in both themes. Twenty scoped layout comparisons pass with zero pixels changed, including newly added Split captures with genuinely narrow viewports rather than only narrow story frames.

A temporary AST converter derives complete styles for each branch of a closed class expression from the original production CSS. It factors out only properties that are identical across all branches, so composing variants cannot discard a default or pseudo-state value. It converts 223 expressions across 85 files, including qualified unstyled Base UI elements and the router's native-attribute forwarding link. Custom renderers, spread-prop Base UI boundaries, unknown expressions, ancestor selectors and cross-condition Tailwind-variable dependencies are skipped. Multi-condition expressions remain manual work: an initial decision-tree experiment introduced impossible TypeScript narrowing, so its complete affected batch was restored before the conservative single-condition pass. Production code has no numeric variant dispatch or utility-string resolver.

The combined AST comparison restores only converted class applications and removes only added StyleX definitions/imports: 85 files, 223 expressions, no non-styling differences. Two explicit WebKit line-clamp properties were separately probed against the original agent-card fixtures before the wider pass. The 19 component tests and full 167-test serial integration suite pass. Artifact-reply and farm-harvest integration scenes exceed twice their timing budget; no budgets or timeouts were raised. The interrupted canonical run contained 170 scenes; subsequent Tag, Dot, layout-control, icon-button and chip scenarios bring the current manifest to 202. It still requires a complete refreshed receipt in phase 6.

The isolated receipt `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-URYUIN/result.json` records code 0, stopped true and no cleanup errors. Eighteen screenshots were manually inspected at desktop and 390px widths: issues, a newly created Markdown artifact, agents, chat, settings, farm, orchestrator memory, runtimes and repositories. The issue, artifact and resulting chat messages contain created data; empty repository/memory and resting farm captures do not establish populated-state acceptance. Narrow settings/runtime captures cover their visible navigation and partial content, not every below-fold control.

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

### Tabs styling contract

Tabs now composes typed StyleX styles instead of accepting a private class string. Its channel, orchestrator, agent configuration and story callers use local definitions. Selected appearance still follows Base UI's data attributes; line-tab icon states use a scoped marker. Browser regression coverage exercises keyboard focus/activation, link navigation and dynamic list width in both themes. All 12 component browser tests and all 26 `web:check` tasks pass. The 26 static visual scenarios retain zero differences. Real-server screenshots cover chat, orchestrator memory and the catalog at 1440×900 and 390×844; sandbox receipt `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-DF69Kb/result.json` records code 0 and successful cleanup. These screenshots verify those page layouts, not the outstanding full live-data comparison matrix.

### Shared controls and reduced motion

Field, its input/textarea/select, MoreMenu, Tip/Hint and Segmented use StyleX definitions. Select callers compose typed placement styles; the segmented thumb's measured geometry passes through StyleX runtime variables. Theme-dependent shadow aliases are restated on themed elements, and default spacing/weight/leading tokens used by migrated components remain explicit in the stylesheet.

The static scenario manifest includes 58 cases, adding input and textarea frames, open selects and menus (including shadows), tooltips and segmented controls. This exposed animation-class-based reduced-motion rules that no longer reached migrated popups. Those popups now disable animation names through StyleX media conditions. Component regressions cover motion preference changes, select keyboard/focus behavior, disabled options, and segmented geometry after selection and resizing. The full component suite passes 15 tests; full repository acceptance remains outstanding.

### Static native-element styles

A temporary AST conversion script, exercised on single-file probes before the wider pass, moves 1,728 static native-element class expressions in 160 previously untouched web files to local StyleX definitions. It reads the original production CSS, preserves declaration order and conditions, and resolves Tailwind's internal variables before emitting styles. Unknown expressions, complex selectors, animation rules and ambiguous shorthand combinations remain unchanged for explicit migration; there is no runtime utility resolver. Two probe files are migrated separately. The production stories build, type/lint checks, all 15 component browser tests and all 26 web-check tasks pass.

Default container widths, large type, tracking, leading and white used by these definitions are now explicit stylesheet tokens rather than depending on utility-driven theme retention. The static comparison manifest has 142 scenarios, adding populated board, messages, runtime details, agent/memory state grids, tables, rich text and pixel sprites. These remain fixture-based visual comparisons, not the outstanding isolated live-data and host matrix. Existing design-token lint must also be converted to understand StyleX before removing its utility-class checks.

The expanded capture exposed unstable rounded-ring rasterization in the original baseline, despite identical geometry, shadows and no running animations. The capture now records a fixed sRGB/raster profile (Skia runtime optimizations and partial raster disabled, one raster thread); a 20-capture baseline probe is pixel-identical with that profile. No pixels are masked and the zero-difference threshold is unchanged. Rich-message fixtures serve a committed one-second black MP4 at their declared attachment URL on both sides, record its hash, and wait for decoded video data; missing media is not silently accepted. All 142 scenarios then pass A/A and candidate comparisons with zero changed pixels and equal text.

An AST comparison of all 162 converted files, removing only the new StyleX declarations/imports and reversing their class applications, finds no other semantic changes across 1,731 expressions. Integration checks also exposed an existing Ctrl+K test race, reproduced on the untouched original revision: opening before the first state frame highlights the notes fallback before channels arrive. The test now asserts the existing `link=open` state-frame handshake before opening; all original interaction assertions remain. Test/note edits after the visual run do not change production UI code, but final aggregate evidence must still rebuild against final inputs.

### Previously touched features, viewer chrome and website native elements

The next static pass converts 202 expressions in nine previously touched web feature files. Its AST comparison retains their existing StyleX declarations and removes only the new declarations and applications; no other semantic changes remain. The website pass converts 160 expressions in eleven components with the same proof, normalizing formatter-added parentheses around JSX. Website spacing and type defaults now have explicit owned declarations, and its theme values remain available independently of utility discovery.

Story frame metadata now accepts `StyleXStyles`, not class strings. Thirteen pixel story files share one host-owned frame definition. The viewer forwards frame runtime variables as object styles while retaining its explicit preview width. Its tree, toolbar, grid labels, argument controls and canvas use local styles with public host tokens. The remaining filled-frame descendant layout contract has not yet been converted.

A separate whole-viewer fixture supplies identical catalogue data to original and candidate package sources. This avoids comparing an intentionally changed production story count or hiding it from screenshots. Both builds use the same fixture and compiler configuration; the original and current Solid package files must match. The report records fixture hashes, runtime files and both output trees. Fourteen new scenes cover both themes, desktop and narrow widths, argument editing and selected-link hover, increasing the full static manifest to 156 scenarios.

These comparisons caught two issues that frame-only captures missed: StyleX 0.19.1 `attrs()` kebab-cases case-sensitive custom property names, and a media-wrapped hover rule overrode the selected link. Tree indentation now uses object styles, and hover excludes the selected link. A new browser regression checks indentation and selected hover precedence in both themes. Dynamic styled boundaries must preserve object styles rather than assume serialized variables are safe.

The 156-scenario full comparison passes A/A and candidate captures with zero changed pixels and equal text; after the website pass, its six route/width comparisons also pass independently. All 16 component browser tests, 18 website production tests and 26 web-check tasks pass. These remain scoped receipts, not final migration acceptance; final canonical builds and the live/host matrix are still required.

### Website style contracts

Website headings, device and screenshot drift containers, scene layers and story sprites now compose typed StyleX styles. Pixel links and counters no longer expose unused class-string props. Story graph dots take a closed semantic tone rather than a utility string; their coordinates and sprite dimensions are StyleX variables forwarded as object styles. Foreground plant layouts no longer keep utility strings in scene descriptors. Motion still owns its inline transforms and presence lifecycle.

The website comparison now also exercises primary and secondary links while hovered, pressed and keyboard-focused. The interaction is followed by the same settling interval on both sides before capture: without this, the original baseline itself showed unsettled scene pixels. All twelve website route/width/state scenarios pass A/A and candidate comparisons with zero changed pixels; the eighteen production behavior checks also pass.

The fail-closed inventory found the new viewer fixture's missing doctype. Its document now declares standards mode, and every visual capture explicitly requires `CSS1Compat`; fixture mode must not silently differ from production. All fourteen viewer comparisons pass again in standards mode. The expanded 162-scenario run reached its last two scenes before the execution window interrupted it, so it has no accepted complete receipt. Full aggregate acceptance remains open.

### Button composition boundary

The workbench Button no longer accepts a private class-string styling prop. Its four remaining callers now pass local StyleX definitions. Composed styles forward their variables as objects, and native object styles merge without discarding those variables. The type separates native-only attributes (including their string and removal forms) from StyleX composition, which accepts only object styles; a caller cannot combine a string style with dynamic StyleX variables.

A dual-theme browser regression checks camel-cased dynamic variables, native style forwarding, keyboard activation, changing dimensions and retained focus. All seventeen component tests and seventeen focused artifact, issue, pairing and runtime-avatar integration tests pass. Twenty button and populated issue fixture comparisons pass A/A and candidate checks with zero changed pixels and equal text; `web:check` passes all twenty-six tasks.

The isolated live receipt `/var/folders/hz/26kbk41x5_j5c4sykmx2yp7r0000gn/T/vibevalley-verify-I2Bt1L/result.json` records successful shutdown and no cleanup errors. Four manually inspected screenshots show a newly created issue and a populated Markdown artifact with its reply control, at 1440×900 and 390×844. This is scoped live evidence, not the final immutable populated-data matrix.

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
