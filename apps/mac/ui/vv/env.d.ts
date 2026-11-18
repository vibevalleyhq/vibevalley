// Globals the vendored VibeValley code names: in a web page they exist; in
// nsh they do not, and the code checks `typeof document` before using it.
interface HTMLElement {
  readonly dataset: Record<string, string | undefined>;
  readonly style: { setProperty(name: string, value: string): void };
}
declare var document: { readonly documentElement: HTMLElement };
declare function structuredClone<T>(value: T): T;
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
declare var localStorage: StorageLike;
declare var window: {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  matchMedia(query: string): {
    readonly matches: boolean;
    addEventListener(type: "change", fn: () => void): void;
    removeEventListener(type: "change", fn: () => void): void;
  };
};
interface History {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  back(): void;
  forward(): void;
}
