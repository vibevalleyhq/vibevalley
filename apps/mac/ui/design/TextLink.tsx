import { Text, View, type JSX } from "nsh";

import { hostApi } from "../infra/bridge";
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
