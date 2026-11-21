import { effect, split, untracked, View, type JSX, type ViewProps } from "nsh";

import { hostApi } from "../bridge";
import { useLocation, useRouter } from "./context";
import { internalUrl, linkHref } from "./history";

const base = "http://router.local";

export type LinkProps = { href: string; replace?: boolean; onPress?: () => void } & Omit<ViewProps, "onPress">;

function follow(router: ReturnType<typeof useRouter>, href: string, replace: boolean | undefined) {
  const from = new URL(router.location().href, base).href;
  const url = internalUrl(href, from);
  if (url) {
    router.navigate(url.pathname + url.search + url.hash, replace === true ? { replace: true } : undefined);
    return;
  }
  const outside = linkHref(href, from);
  if (outside !== undefined) void hostApi.openUrl(outside);
}

export function Link(props: LinkProps) {
  const router = useRouter();
  // nsh's View takes children as its own prop, not through a spread.
  const [own, rest] = split(props, ["href", "replace", "onPress", "children"] as const);
  return (
    <View
      role="link"
      {...rest}
      onPress={() => {
        own.onPress?.();
        follow(router, own.href, own.replace);
      }}
    >
      {own.children}
    </View>
  );
}

/** Whether `href` is the place shown now (or above it, unless `end`). */
function useActive(href: () => string, end?: () => boolean | undefined): () => boolean {
  const location = useLocation();
  return () => {
    const url = internalUrl(href(), new URL(location().href, base).href);
    if (!url) return false;
    const path = location().pathname;
    return (
      path === url.pathname || (end?.() !== true && url.pathname !== "/" && path.startsWith(url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`))
    );
  };
}

export function NavLink(props: LinkProps & { end?: boolean }) {
  const active = useActive(
    () => props.href,
    () => props.end,
  );
  const [own, rest] = split(props, ["end", "accessibilityState", "children"] as const);
  return (
    <Link {...rest} accessibilityState={{ ...own.accessibilityState, selected: active() }}>
      {own.children}
    </Link>
  );
}

export function Navigate(props: { href: string }): JSX.Element {
  const router = useRouter();
  effect(() => {
    const href = props.href;
    untracked(() => queueMicrotask(() => router.navigate(href, { replace: true })));
  });
  return null;
}
