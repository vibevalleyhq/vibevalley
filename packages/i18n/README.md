# @vibevalley/i18n

What VibeValley says to the owner, in Chinese and English ([where words go](docs/subsystems/foundation.md#话放在哪)).
What is said to a model is not here: it is in `crates/vibevalley-server/assets`.

| Where | What |
|---|---|
| `crates/vibevalley-i18n/locales/<locale>/<namespace>.json` | the catalogs, one file per host and module (`web.setting`, `server.issue`, `cli`, `desktop`, `shared`); zh is the source; the Rust server embeds its own (`server.*`, `cli`, `shared`) |
| `src/index.ts` | `t(key, params?)`, `list(items)`, `currentLocale`, `setLocale` |
| `src/format.ts` | `{name}`, `{n, plural, …}` (`#` is the count), `{n, selectordinal, …}`, `{flag, select, true {…} other {…}}` |
| `src/catalogs.ts` | written by `vp run i18n:gen`: the catalogs as data, and every key with its params' types |
| `crates/vibevalley-i18n/same.json` | messages every language says the same way (a language's own name) |

```bash
vp run i18n:gen               # after editing crates/vibevalley-i18n/locales/: rewrite catalogs.ts
vpx scripts/gen/i18n.ts check     # in docs:verify: missing, unused, untranslated, mismatched placeholders
vpx scripts/gen/i18n.ts find 存好  # which key says it
vp run test                   # vitest: t, the formats, the types
```

Usage checks read the TypeScript under `apps/` and `packages/`, `scripts/`, and the Rust sources (`check --rust` for the
`server.*` and `cli.*` keys).
