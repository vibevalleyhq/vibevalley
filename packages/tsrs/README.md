# @vibevalley/tsrs

TypeScript here runs on [tsrs](https://github.com/oxc-repo/tsrs), the Rust port of TypeScript 7, in two places:

- **`vp check`**: oxlint's type-aware rules and the type check (`typeAware`, `typeCheck` in the root
  `vite.config.ts`) run through a tsgolint binary that Vite+ resolves from `oxlint-tsgolint`. This package stands in
  for it (`pnpm-workspace.yaml`'s `overrides`): `bin/tsgolint` hands every call to tsrs's `tsrs-lint`, which speaks
  tsgolint's protocol and has all of its rules. On this repository the lint takes about half the time, a third of the
  CPU and less memory than tsgolint.
- **The editor**: `.vscode/settings.json` points the TypeScript 7 extension at `tsdk/`, whose `tsgo` is the same tsrs,
  so the editor and `vp check` agree on every type.
