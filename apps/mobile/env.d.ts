// Minimal DOM ambient declarations checked via `typeof document` inside shared `@vibevalley/i18n/src/locale.ts`.
interface HTMLElement {
  readonly dataset: Record<string, string | undefined>;
}
declare var document: { readonly documentElement: HTMLElement };
