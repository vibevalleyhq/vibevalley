import type { JSX } from "@solidjs/web";
import { createEffect, omit } from "solid-js";

import { useLocation, useRouter } from "./context";
import { internalUrl, linkHref } from "./history";

export type LinkProps = { href: string; replace?: boolean } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

export function Link(props: LinkProps) {
  const router = useRouter();
  const rest = omit(props, "href", "replace", "onClick");
  return (
    <a
      {...rest}
      href={linkHref(props.href, new URL(router.location().href, window.location.origin).href)}
      onClick={(event) => {
        const click = props.onClick;
        if (typeof click === "function") click(event);
        else if (click) click[0](click[1], event);
        const anchor = event.currentTarget;
        if (linkHref(anchor.href, window.location.href) === undefined) {
          event.preventDefault();
          return;
        }
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          anchor.hasAttribute("download") ||
          (anchor.target !== "" && anchor.target !== "_self")
        )
          return;
        const url = internalUrl(anchor.href, window.location.href);
        if (!url) return;
        event.preventDefault();
        router.navigate(url.pathname + url.search + url.hash, props.replace === true ? { replace: true } : undefined);
      }}
    />
  );
}

export function NavLink(props: LinkProps & { end?: boolean }) {
  const location = useLocation();
  const rest = omit(props, "end", "aria-current");
  const active = () => {
    const url = internalUrl(props.href, new URL(location().href, window.location.origin).href);
    if (!url) return false;
    const path = location().pathname;
    return (
      path === url.pathname || (props.end !== true && url.pathname !== "/" && path.startsWith(url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`))
    );
  };
  return <Link {...rest} aria-current={props["aria-current"] ?? (active() ? "page" : undefined)} />;
}

export function Navigate(props: { href: string }) {
  const router = useRouter();
  createEffect(
    () => props.href,
    (href) => router.navigate(href, { replace: true }),
  );
  return null;
}
