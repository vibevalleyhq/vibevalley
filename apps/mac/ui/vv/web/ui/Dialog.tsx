// Ported from VibeValley apps/web/src/ui/Dialog.tsx: base-ui's Dialog
// becomes nsh/base's (a modal with a backdrop; Escape and a press on the
// backdrop ask onClose), the same box and title bar.
import { Scroll, Text, View, windowSize, type JSX } from "nsh";
import { Dialog as Base } from "nsh/base";

/** A modal over the page. Open while `open`. */
export function Dialog(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element; wide?: boolean; testid?: string }) {
  const width = () => Math.min(props.wide === true ? 1080 : 480, windowSize().width * (props.wide === true ? 0.94 : 0.92));
  return (
    <Base
      open={props.open}
      testID={props.testid}
      accessibilityLabel={props.title}
      animation="fade"
      onOpenChange={(e) => !e.open && props.onClose()}
      backdropClass="bg-scrim"
      class="m-auto rounded-lg border border-line bg-page shadow-float"
      style={{ width: width(), maxHeight: windowSize().height * 0.86 }}
    >
      <View class="border-b border-line px-5 py-3">
        <Text role="header" class="text-base font-semibold text-ink">
          {props.title}
        </Text>
      </View>
      <Scroll class="shrink">
        <View class="px-5 py-4">{props.children}</View>
      </Scroll>
    </Base>
  );
}
