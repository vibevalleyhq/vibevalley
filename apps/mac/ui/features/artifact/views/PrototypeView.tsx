import { computed, View, WebView } from "nsh";

import type { Artifact } from "@vibevalley/protocol";

import { Keyed } from "../../../infra/base/dom";
import { buildPrototypeDocument } from "../frame";

export type PrototypeViewport = "full" | "tablet" | "mobile";

export function PrototypeView(props: {
  readonly artifact: Artifact;
  readonly files: ReadonlyMap<string, string>;
  readonly viewport: PrototypeViewport;
  readonly activeEntry?: string | undefined;
  readonly reloadKey?: number | undefined;
  readonly covered?: boolean | undefined;
}) {
  const prototypeHtml = computed(() => buildPrototypeDocument(props.files, props.activeEntry));

  const frameWidth = () => {
    const mode = props.viewport;
    if (mode === "mobile") return 390;
    if (mode === "tablet") return 768;
    return undefined;
  };

  return (
    <View testID="artifact-prototype-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <View class={`min-h-0 min-w-0 flex-1 ${frameWidth() !== undefined ? "items-center bg-side p-4" : ""}`}>
        <View
          class={
            frameWidth() !== undefined ? "min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-page shadow-raise" : "min-h-0 w-full flex-1 bg-page"
          }
          style={frameWidth() !== undefined ? { width: frameWidth(), maxWidth: "100%" } : undefined}
        >
          <Keyed key={`${props.activeEntry ?? "default"}:${props.reloadKey ?? 0}`}>
            {() => (
              /* Strictly sandboxed WebView: incognito + strict CSP via buildPrototypeDocument (never shares host origin). */
              <WebView
                testID="artifact-prototype-webview"
                accessibilityLabel={props.artifact.title}
                html={prototypeHtml()}
                incognito
                class="min-h-0 w-full flex-1 bg-page"
                style={props.covered === true ? { opacity: 0 } : undefined}
              />
            )}
          </Keyed>
        </View>
      </View>
    </View>
  );
}
