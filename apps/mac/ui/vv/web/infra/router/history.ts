export interface Location {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly href: string;
}

export interface Navigation {
  readonly replace?: boolean;
}

export interface RouterHistory {
  readonly read: () => Location;
  readonly navigate: (to: string, options?: Navigation) => void;
  readonly back: () => void;
  readonly forward: () => void;
  readonly subscribe: (changed: () => void) => () => void;
}

function locationOf(url: URL): Location {
  return { pathname: url.pathname, search: url.search, hash: url.hash, href: url.pathname + url.search + url.hash };
}

export function internalUrl(to: string, base: string): URL | undefined {
  try {
    const url = new URL(to, base);
    const origin = new URL(base).origin;
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin ? url : undefined;
  } catch {
    return undefined;
  }
}

export function linkHref(to: string, base: string): string | undefined {
  try {
    const url = new URL(to, base);
    if (url.protocol === "mailto:" || url.protocol === "tel:") return url.href;
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin === new URL(base).origin ? locationOf(url).href : url.href;
  } catch {
    return undefined;
  }
}

export function browserHistory(browser: {
  readonly location: { readonly href: string };
  readonly history: Pick<History, "pushState" | "replaceState" | "back" | "forward">;
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
}): RouterHistory {
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: () => locationOf(new URL(browser.location.href)),
    navigate: (to, options) => {
      const url = internalUrl(to, browser.location.href);
      if (!url) throw new Error(`Navigation must stay within the application: ${to}`);
      const href = locationOf(url).href;
      if (options?.replace === true) browser.history.replaceState(null, "", href);
      else if (url.href !== browser.location.href) browser.history.pushState(null, "", href);
      changed();
    },
    back: () => browser.history.back(),
    forward: () => browser.history.forward(),
    subscribe: (listener) => {
      if (listeners.size === 0) {
        browser.addEventListener("popstate", changed);
        browser.addEventListener("hashchange", changed);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          browser.removeEventListener("popstate", changed);
          browser.removeEventListener("hashchange", changed);
        }
      };
    },
  };
}

export function memoryHistory(initial = "/"): RouterHistory {
  const origin = "http://router.local";
  const first = internalUrl(initial, origin);
  if (!first) throw new Error(`Invalid initial route: ${initial}`);
  const entries = [first];
  let index = 0;
  let current = first;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const move = (offset: number) => {
    const next = entries[index + offset];
    if (!next) return;
    index += offset;
    current = next;
    changed();
  };
  return {
    read: () => locationOf(current),
    navigate: (to, options) => {
      const next = internalUrl(to, current.href);
      if (!next) throw new Error(`Navigation must stay within the application: ${to}`);
      if (options?.replace === true) entries[index] = next;
      else if (next.href !== current.href) {
        entries.splice(index + 1);
        entries.push(next);
        index++;
      }
      current = next;
      changed();
    },
    back: () => move(-1),
    forward: () => move(1),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export type SearchUpdate = Readonly<Record<string, string | readonly string[] | undefined>>;

export function updateSearch(location: Location, update: SearchUpdate): string {
  const search = new URLSearchParams(location.search);
  for (const [name, values] of Object.entries(update)) {
    search.delete(name);
    if (values !== undefined) for (const value of typeof values === "string" ? [values] : values) search.append(name, value);
  }
  const encoded = search.toString();
  return location.pathname + (encoded ? `?${encoded}` : "") + location.hash;
}
