# design-system: Standing Design Tokens & Component Catalog

`design-system` (`body = "store"`, `artifactType: "design-system"`) defines reusable light/dark tokens, typography specimens, guidelines, and live component previews. When marked `isDefault: true`, its compiled CSS tokens are automatically injected into `slides`, `dashboard`, and `design` viewers.

## Entry Layout

- `"project/design-system.json"` (JSON): `{ "name": "...", "version": "1.0.0", "components": [{ "id": "Button", "title": "Button", "preview": "project/components/Button/preview.html" }] }`
- `"project/tokens.json"` (JSON): List-based token specification (`themes`, `defaultTheme`, `color`, `type`, `space`, `radius`, `shadow`, `border`, `motion`) supporting `{ light, dark }` values and `{alias}` references.
- `project/README.md` (text): Design principles and usage guidelines.
- `project/components/<Name>/preview.html` (text): Live component specimens consuming `var(--color-*)` and `var(--radius-*)`.

Further references: `artifact_type_read({ type: "design-system", reference: "format" | "tokens-craft" })`.
