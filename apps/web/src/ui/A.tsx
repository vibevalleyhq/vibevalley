import type { JSX } from "@solidjs/web";
import { omit, onSettled } from "solid-js";

import { useRouter } from "@/infra/router";

/** A link inside the page: a plain click moves the router, a click with a modifier (a new tab) is the browser's. */
export function A(props: { href: string; replace?: boolean } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const router = useRouter();
  const rest = omit(props, "href", "replace", "onClick");
  return (
    <a
      {...rest}
      href={props.href}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        router.navigate(props.href, props.replace === true ? { replace: true } : undefined);
      }}
    />
  );
}

/** Moves to `href` once drawn, in place of the entry it is in: where a path the page does not know lands. */
export function Navigate(props: { href: string }) {
  const router = useRouter();
  onSettled(() => router.navigate(props.href, { replace: true }));
  return null;
}
