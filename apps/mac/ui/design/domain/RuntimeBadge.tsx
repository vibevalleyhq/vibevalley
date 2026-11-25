import { Image, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { RuntimeInfo } from "@vibevalley/protocol";

import { ready, useRuntimes } from "../../infra/query";
import { engineLogoUrl, useAssetsDir } from "../art";
import { Icon } from "../Icon";
import { Bubble } from "../Tip";

/** The runtime list's label for it; the runtime's id when unlisted. */
export const runtimeName = (runtimes: readonly RuntimeInfo[], runtime: string) => runtimes.find((r) => r.id === runtime)?.preset.label ?? runtime;

/** The first letter of a name, as a face or a mark shows it when no portrait is loaded. */
export const initialOf = (name: string) => ([...name.trim()][0] ?? "?").toUpperCase();

/** The execution engine badge stamped on a profile or session portrait. */
export function RuntimeBadge(props: { runtime: string; size: number }) {
  const runtimes = useRuntimes();
  const assetsDir = useAssetsDir();
  const name = () => runtimeName(ready(runtimes, []), props.runtime);
  const label = () => t("web.base.runtime", { name: name() });
  const logo = () => {
    const dir = assetsDir();
    return dir ? engineLogoUrl(dir, props.runtime) : undefined;
  };
  return (
    <View
      role="image"
      accessibilityLabel={label()}
      tooltip={<Bubble text={label()} />}
      class="absolute -right-0.5 -bottom-0.5 z-10 items-center justify-center rounded-xs border border-line-strong bg-paper p-px shadow-raise"
      style={{ width: props.size, height: props.size }}
    >
      <If when={logo()} else={<Icon name="runtimes" size={Math.max(8, props.size - 4)} tone="bark" />}>
        {(src) => <Image src={src()} style={{ width: props.size - 3, height: props.size - 3, objectFit: "contain" }} />}
      </If>
    </View>
  );
}
