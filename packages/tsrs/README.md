# @vibevalley/tsrs

TypeScript here runs on [tsrs](https://github.com/oxc-repo/tsrs), the Rust port of TypeScript 7, in two places:

- **`vp check`**: oxlint's type-aware rules and the type check (`typeAware`, `typeCheck` in the root
  `vite.config.ts`) run through a tsgolint binary that Vite+ resolves from `oxlint-tsgolint`. This package stands in
  for it (`pnpm-workspace.yaml`'s `overrides`): `bin/tsgolint` hands every call to tsrs's `tsrs-lint`, which speaks
  tsgolint's protocol and has all of its rules. On this repository the lint takes about half the time, a third of the
  CPU and less memory than tsgolint.
- **The editor**: `.vscode/settings.json` points the TypeScript 7 extension at `tsdk/`, whose `tsgo` is tsrs with
  Effect's language service (`effect-tsgo tsrs`, from `@effect/tsgo`, which ships it for the tsrs version installed
  here), so Effect's diagnostics and quick fixes show while editing. Nothing in `node_modules` is patched.

Effect's diagnostics as a check are `vp run effect:check` (`effect-tsgo diagnostics`), not `vp check`: running them in
oxlint needs Effect's patched oxlint, which follows oxlint's versions behind Vite+.

`tsrs` and `@effect/tsgo` move together: `@effect/tsgo`'s README lists the tsrs versions each release ships.
