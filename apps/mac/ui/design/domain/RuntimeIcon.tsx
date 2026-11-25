import { Image, View } from "nsh";

import { engineLogoUrl, useAssetsDir } from "../art";
import { Icon } from "../Icon";

/** A runtime/engine emblem: Papertrails cardstock tile when available, else a framed icon fallback. */
export function RuntimeIcon(props: { runtime: string; size: number }) {
  const assetsDir = useAssetsDir();
  const logo = () => {
    const dir = assetsDir();
    return dir ? engineLogoUrl(dir, props.runtime) : undefined;
  };
  return (
    <If
      when={logo()}
      else={
        <View
          class="shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-paper shadow-raise"
          style={{ width: props.size, height: props.size }}
        >
          <Icon name="runtimes" size={Math.max(12, Math.round(props.size * 0.52))} tone="bark" />
        </View>
      }
    >
      {(src) => <Image src={src()} class="shrink-0" style={{ width: props.size, height: props.size, objectFit: "contain" }} />}
    </If>
  );
}
