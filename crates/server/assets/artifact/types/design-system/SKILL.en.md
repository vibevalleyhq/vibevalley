# design-system: Token Library & Component Specs

`design-system` defines reusable light/dark colors, typography scales, spacing, radii, shadows, motion curves, and component specs shared across `slides`, `dashboard`, `design`, and `prototype` artifacts. Stored as a directory in `storage/` (`<storage>/artifact/<id>/`), tokens live in `structure/tokens.json`, component specs in `structure/components/*.json`, and brand media in `asset/`.

## Directory Layout

```text
<storage>/artifact/<id>/
├── manifest.json                 # id, artifactType: "design-system", title, version, isDefault
├── structure/
│   ├── tokens.json               # Light/dark colors, typography, space, radius, shadow, border, motion
│   └── components/
│       ├── button.json           # Variants, state matrix, token bindings, and do/don't rules
│       └── input.json
└── asset/
    └── brand-mark.svg            # Brand marks and visual specimens referenced via asset/<name>
```

Example `manifest.json`:
```json
{
  "id": "art_ds_01",
  "artifactType": "design-system",
  "title": "Fieldcraft Design System",
  "version": "1.0.0",
  "entry": "structure/tokens.json",
  "components": ["structure/components/button.json", "structure/components/input.json"]
}
```

## Multi-Human & Multi-Agent Collaboration Rules

1. **Token & per-component CRDT sync (`artifact_collab`)**: Keep global tokens in `structure/tokens.json` and isolate each component in `structure/components/<name>.json`. Humans and agents can add or refine different components concurrently while `artifact_collab` merges edits conflict-free.
2. **Origin-tracked releases (`artifact_change`)**: Every token or component change records its `origin` for audit and undo-by-origin. Cut immutable `artifact_version` snapshots before downstream artifacts adopt major token updates.
3. **Review suggestions (`artifact_suggestion`)**: Changing user-locked brand colors, type scales, or core radii must go through `artifact_suggestion` with contrast verification before taking effect.
4. **Live presence awareness**: Check which token groups or component specs collaborators are currently editing and parallelize on distinct component files.

## Token Craft Iron Rules

- **WCAG AA in both themes**: `ink` on `surface` and CTA label on `accent` must reach ≥ 4.5:1 contrast in **both** light and dark themes.
- **Alias-driven specs**: Component files reference `{color.*}`, `{space.*}`, and `{radius.*}` aliases rather than raw hex or pixel literals.

Further references: `artifact_type_read({ type: "design-system", reference: "format" | "tokens-craft" })`.
