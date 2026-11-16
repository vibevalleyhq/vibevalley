import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

import { storeViewUrl } from "@vibevalley/artifact/viewers";
import type { Artifact } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { shownTheme } from "#/state/prefs.ts";

import { useShown } from "./frame";
import { MotionControls } from "./MotionControls";
import { useStoreEntries } from "./store";

export function MotionStoreView(props: { artifact: Artifact; frameStyle?: JSX.ClassValue }) {
  const { snapshot } = useStoreEntries(() => props.artifact.id);
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  const shown = useShown(frame);
  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  return (
    <div data-testid="motion-store-view" class="flex min-h-0 min-w-0 flex-1 flex-col">
      <Show when={snapshot().error}>{(err) => <p class="px-3 py-2 text-xs text-berry">{err()}</p>}</Show>
      <iframe
        ref={setFrame}
        data-testid="motion-store-frame"
        title={props.artifact.title}
        src={storeViewUrl(props.artifact.id, { theme: shownTheme(), seq: seq() })}
        sandbox={htmlSandbox}
        referrerpolicy="no-referrer"
        allow="fullscreen"
        class={props.frameStyle ?? "min-h-[56vh] xl:min-h-0 w-full flex-1 rounded-t-lg border border-line bg-page"}
      />
      <MotionControls artifact={props.artifact} version={seq()} shown={shown} frame={frame} />
    </div>
  );
}
