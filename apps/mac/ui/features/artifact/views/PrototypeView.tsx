import { computed, effect, View, WebView } from "nsh";

import type { Artifact } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { api } from "../../../infra/api";
import { Keyed } from "../../../infra/base/dom";
import { currentHost } from "../../../infra/host";
import { useQueryClient } from "../../../infra/query";
import { buildPrototypeDocument } from "../frame";

export type PrototypeViewport = "full" | "tablet" | "mobile";

const COVER_CAPTURE_DELAY_MS = 800;
const COVER_CAPTURE_WIDTH = 640;
const COVER_CAPTURE_HEIGHT = 400;

/** Tracks `${artifactId}:${seq}` pairs already attempted this session so failed or no-op captures do not loop. */
const attemptedCoverCaptures = new Set<string>();

export function resetCapturedCoverCache(): void {
  attemptedCoverCaptures.clear();
}

export function PrototypeView(props: {
  readonly artifact: Artifact;
  readonly files: ReadonlyMap<string, string>;
  readonly viewport: PrototypeViewport;
  readonly activeEntry?: string | undefined;
  readonly reloadKey?: number | undefined;
  readonly covered?: boolean | undefined;
  readonly version?: number | undefined;
  readonly seq?: number | undefined;
}) {
  const queries = useQueryClient();
  const prototypeHtml = computed(() => buildPrototypeDocument(props.files, props.activeEntry));
  const hasHtmlContent = computed(() => [...props.files.keys()].some((k) => /\.(?:html|htm)$/iu.test(k)));
  const isDefaultEntry = computed(() => props.activeEntry === undefined || props.activeEntry === "structure/index.html");
  const liveSeq = computed(() => props.seq ?? props.artifact.seq);

  effect(() => {
    if (props.version !== undefined) return;
    if (props.covered === true) return;
    if (props.viewport !== "full") return;
    if (!isDefaultEntry() || !hasHtmlContent()) return;
    const id = props.artifact.id;
    const seq = liveSeq();
    if (props.artifact.cover?.seq === seq) return;
    const capture = currentHost().captureWebView;
    if (capture === undefined) return;

    const attemptKey = `${id}:${seq}`;
    if (attemptedCoverCaptures.has(attemptKey)) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      attemptedCoverCaptures.add(attemptKey);
      void (async () => {
        try {
          const captured = await capture({ width: COVER_CAPTURE_WIDTH, height: COVER_CAPTURE_HEIGHT });
          if (cancelled || captured === null) return;
          await api.artifact.cover.set({
            id: artifactId(id),
            seq,
            mime: captured.mime,
            data: captured.data,
            width: captured.width,
            height: captured.height,
          });
          if (!cancelled) {
            void queries.invalidate({ prefix: ["artifacts"] });
          }
        } catch {
          // Background auto-cover capture is silent best-effort; never surface errors to the user.
        }
      })();
    }, COVER_CAPTURE_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

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
