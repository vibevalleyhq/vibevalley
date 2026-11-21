import { View } from "nsh";

import { Banner } from "../../design/layout";
import { createSignal } from "../../infra/solid";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { MotionControls } from "./MotionControls";
import { useStoreEntries } from "./store";
import type { StoreViewerProps } from "./StoreArtifactView";

export function MotionStoreView(props: StoreViewerProps) {
  const { snapshot } = useStoreEntries(() => props.artifact.id);
  const [frame, setFrame] = createSignal<Frame>();
  const seq = () => (snapshot().seq > 0 ? snapshot().seq : props.artifact.seq);

  return (
    <View testID="motion-store-view" class="min-h-0 min-w-0 flex-1">
      <If when={snapshot().error}>{(err) => <Banner edge>{err()}</Banner>}</If>
      <HtmlFrame
        artifact={props.artifact}
        version={seq()}
        viewSeq={seq()}
        title={props.artifact.title}
        testId="motion-store-frame"
        frameClass={props.frameClass ?? "min-h-0 w-full flex-1 bg-page"}
        hideControls
        covered={props.covered}
        onFrame={(f) => setFrame(f)}
        onPresent={props.onPresent}
      />
      <If when={frame()}>{(f) => <MotionControls artifact={props.artifact} version={seq()} frame={f()} onPresent={(on) => props.onPresent?.(on)} />}</If>
    </View>
  );
}
