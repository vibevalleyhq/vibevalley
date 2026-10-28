# @vibevalley/i18n

What VibeValley says to the owner, in Chinese and English ([where words go](docs/subsystems/foundation.md#话放在哪)).
What is said to a model is not here: it stays in each module's `prompts.ts`.

| Where | What |
|---|---|
| `locales/<locale>/<namespace>.json` | the catalogs, one file per host and module (`web.setting`, `server.issue`, `desktop`, `mobile`, `shared`); zh is the source |
| `src/index.ts` | `t(key, params?)`, `maybe(key)` for a key built from a value that may name none, `list(items)`, `currentLocale`, `setLocale` |
| `src/format.ts` | `{name}`, `{n, plural, …}` (`#` is the count), `{n, selectordinal, …}`, `{flag, select, true {…} other {…}}` |
| `src/catalogs.ts` | written by `vp run i18n:gen`: the catalogs as data, and every key with its params' types |
| `same.json` | messages every language says the same way (a language's own name) |

```bash
vp run i18n:gen               # after editing locales/: rewrite catalogs.ts
vpx scripts/i18n.ts check     # in docs:verify: missing, unused, untranslated, mismatched placeholders
vpx scripts/i18n.ts find 存好  # which key says it
vp run test                   # vitest: t, the formats, the types
```
