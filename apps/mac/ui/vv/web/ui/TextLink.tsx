// Ported from VibeValley apps/web/src/ui/layout.tsx's TextLink (layout.tsx
// here leaves it out). There a link opens in the browser; here a workbench
// path ("/settings/accounts") goes through the router and any other address
// to the host's browser (hostApi.openUrl).
import { Text, View, type JSX } from "nsh";

import { hostApi } from "../../../bridge";
import { useRouter } from "../infra/router";

/** A quiet underlined word: a page to open, or onClick. */
export function TextLink(props: { children: JSX.Element; href?: string; onClick?: () => void; danger?: boolean; testid?: string }) {
  const router = useRouter();
  const go = () => {
    const href = props.href;
    if (href === undefined) return props.onClick?.();
    if (href.startsWith("/")) router.navigate(href);
    else void hostApi.openUrl(href);
  };
  return (
    <View role={props.href === undefined ? "button" : "link"} testID={props.testid} onPress={go} class="self-start">
      <Text class={`text-xs underline hover:text-ink ${props.danger === true ? "text-berry" : "text-muted"}`}>{props.children}</Text>
    </View>
  );
}
