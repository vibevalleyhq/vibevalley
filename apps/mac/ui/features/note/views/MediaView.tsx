import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { IssueId, Note, NoteFileMeta } from "@vibevalley/protocol";
import { issueId as toIssueId } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Empty, Toggle } from "../../../design/layout";
import { Segmented } from "../../../design/Segmented";
import { CountPill } from "../../../design/Tag";
import { toast } from "../../../design/toasts";
import { mix, tone } from "../../../design/tone";
import { api, reasonOf } from "../../../infra/api";
import { playAudio } from "../../../infra/attachmentFile";
import { useInterval } from "../../../infra/base/timer";
import { transport } from "../../../infra/transport";
import { saveBase64File, saveTextFile, useNoteDirectory } from "./noteFiles";

export interface MediaViewProps {
  readonly note: Note;
  readonly version?: number | undefined;
  readonly onOpenIssue?: ((id: IssueId) => void) | undefined;
}

type MediaTabMode = "media" | "storyboard" | "motion" | "assets";

interface TranscriptCue {
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly speaker: string;
  readonly text: string;
}

interface MediaItemModel {
  readonly id: string;
  readonly kind: string;
  readonly src: string;
  readonly title: string;
  readonly caption: string;
  readonly durationSec: number | undefined;
  readonly issueId: IssueId | undefined;
  readonly jobId: string | undefined;
  readonly transcript: readonly TranscriptCue[];
}

interface StoryboardShotModel {
  readonly id: string;
  readonly scene: string;
  readonly durationSec: number;
  readonly framing: string;
  readonly camera: string;
  readonly visual: string;
  readonly dialogue: string;
  readonly sfx: string;
  readonly transitionOut: string;
  readonly status: string;
}

interface MotionSceneModel {
  readonly id: string;
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly title: string;
  readonly layers: readonly Record<string, unknown>[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asRecordArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function evaluateMotionLayer(
  layer: Record<string, unknown>,
  localProgress: number,
): { readonly opacity: number; readonly offsetY: number; readonly scale: number } {
  const clamped = Math.max(0, Math.min(1, localProgress));
  const baseOpacity = asNumber(layer.opacity, 1);
  const enterEnd = 0.22;
  const enterT = Math.min(1, clamped / enterEnd);
  const eased = 1 - Math.pow(1 - enterT, 3);
  return {
    opacity: Number((baseOpacity * eased).toFixed(3)),
    offsetY: Number(((1 - eased) * 14).toFixed(2)),
    scale: Number((0.95 + eased * 0.05).toFixed(3)),
  };
}

function mediaKindIcon(kind: string) {
  switch (kind.toLowerCase()) {
    case "audio":
      return "audio" as const;
    case "video":
      return "video" as const;
    case "image":
      return "image" as const;
    default:
      return "media" as const;
  }
}

function FramingGuide(props: { readonly framing: string; readonly color?: string | undefined }) {
  return (
    <View class="h-full w-full items-center justify-center p-3">
      <If when={props.framing === "extreme-wide" || props.framing === "wide"}>
        <View class="h-full w-full justify-between rounded-sm border px-3 py-2" style={{ borderColor: mix("ink", 0.18) }}>
          <View class="h-1.5 w-10 rounded-full opacity-45" style={{ backgroundColor: props.color ?? mix("ink", 0.35) }} />
          <View class="h-px w-full" style={{ backgroundColor: mix("ink", 0.2) }} />
          <View class="flex-row items-end justify-between">
            <View class="h-5 w-10 rounded-xs opacity-60" style={{ backgroundColor: props.color ?? mix("accent", 0.4) }} />
            <View class="h-3 w-14 rounded-xs opacity-35" style={{ backgroundColor: mix("ink", 0.25) }} />
          </View>
        </View>
      </If>
      <If when={props.framing === "close-up" || props.framing === "extreme-close-up"}>
        <View
          class="size-14 items-center justify-center rounded-full border-2"
          style={{ borderColor: props.color ?? mix("accent", 0.65), backgroundColor: mix("accent", 0.16) }}
        >
          <View class="size-5 rounded-full" style={{ backgroundColor: props.color ?? mix("accent", 0.7) }} />
        </View>
      </If>
      <If when={props.framing !== "extreme-wide" && props.framing !== "wide" && props.framing !== "close-up" && props.framing !== "extreme-close-up"}>
        <View class="h-12 w-24 items-center justify-center rounded-md border" style={{ borderColor: mix("ink", 0.24), backgroundColor: mix("water", 0.14) }}>
          <View class="h-2 w-12 rounded-xs bg-ink opacity-40" />
        </View>
      </If>
    </View>
  );
}

/** Unified Media view supporting audio/transcripts, video/images, storyboard scenes, motion clips, and `asset/*` files. */
export function MediaView(props: MediaViewProps) {
  const { snapshot } = useNoteDirectory(
    () => props.note.id,
    () => props.version,
  );

  const tabMode = signal<MediaTabMode>("media");
  const storyboardAnimatic = signal(false);
  const activeShotIdx = signal(0);
  const shotPlaying = signal(false);
  const motionHead = signal(0);
  const motionPlaying = signal(false);
  const motionLoop = signal(true);
  const activeAudioId = signal<string | undefined>(undefined);

  const mediaJson = computed(() => parseJsonObject(snapshot().contents.get("structure/media.json")?.content));
  const shotsJson = computed(() => parseJsonObject(snapshot().contents.get("structure/shots.json")?.content));
  const assetFiles = computed((): readonly NoteFileMeta[] =>
    [...snapshot().files.values()].filter((f) => f.path.startsWith("asset/")).toSorted((a, b) => a.path.localeCompare(b.path)),
  );

  const mediaDoc = computed(() => {
    const obj = mediaJson();
    const defaultKind = asString(obj?.mediaKind, "audio");
    const items: MediaItemModel[] = asRecordArray(obj?.items).map((item, idx) => {
      const cues: TranscriptCue[] = asRecordArray(item.transcript).map((c, cIdx) => ({
        id: asString(c.id, `cue-${idx}-${cIdx}`),
        startSec: asNumber(c.startSec ?? c.start, 0),
        endSec: asNumber(c.endSec ?? c.end, 0),
        speaker: asString(c.speaker),
        text: asString(c.text),
      }));
      return {
        id: asString(item.id, `m-${idx + 1}`),
        kind: asString(item.kind, defaultKind),
        src: asString(item.src),
        title: asString(item.title, asString(item.src, `Item ${idx + 1}`)),
        caption: asString(item.caption),
        durationSec: typeof item.durationSec === "number" ? item.durationSec : undefined,
        issueId: typeof item.issueId === "string" && item.issueId ? toIssueId(item.issueId) : undefined,
        jobId: typeof item.jobId === "string" && item.jobId ? item.jobId : undefined,
        transcript: cues,
      };
    });

    const topTranscript: TranscriptCue[] = asRecordArray(obj?.transcript).map((c, cIdx) => ({
      id: asString(c.id, `top-cue-${cIdx}`),
      startSec: asNumber(c.startSec ?? c.start, 0),
      endSec: asNumber(c.endSec ?? c.end, 0),
      speaker: asString(c.speaker),
      text: asString(c.text),
    }));

    return {
      title: asString(obj?.title, props.note.title),
      mediaKind: defaultKind,
      caption: asString(obj?.caption),
      durationSec: typeof obj?.durationSec === "number" ? obj.durationSec : undefined,
      posterAsset: typeof obj?.posterAsset === "string" ? obj.posterAsset : undefined,
      issueId: typeof obj?.issueId === "string" && obj.issueId ? toIssueId(obj.issueId) : props.note.issue,
      items,
      topTranscript,
    };
  });

  const storyboardModel = computed(() => {
    const src = shotsJson() ?? mediaJson();
    const styleGuide = isRecord(src?.styleGuide) ? src.styleGuide : undefined;
    const palette = Array.isArray(styleGuide?.palette) ? styleGuide.palette.filter((x): x is string => typeof x === "string") : [];
    const shots: StoryboardShotModel[] = asRecordArray(src?.shots).map((s, idx) => ({
      id: asString(s.id, `sh${String(idx + 1).padStart(2, "0")}`),
      scene: asString(s.scene),
      durationSec: asNumber(s.durationSec, 3),
      framing: asString(s.framing, "wide"),
      camera: asString(s.camera, "static"),
      visual: asString(s.visual),
      dialogue: asString(s.dialogue),
      sfx: asString(s.sfx),
      transitionOut: asString(s.transitionOut, "cut"),
      status: asString(s.status, "draft"),
    }));
    return {
      aspectRatio: asString(src?.aspectRatio, "16:9"),
      fps: asNumber(src?.fps, 30),
      visualTone: asString(styleGuide?.visualTone),
      palette,
      shots,
    };
  });

  const motionModel = computed(() => {
    const obj = mediaJson();
    const contents = snapshot().contents;
    const scenes: MotionSceneModel[] = asRecordArray(obj?.scenes).map((sc, idx) => {
      const file = asString(sc.file);
      const detail = parseJsonObject(file ? contents.get(file)?.content : undefined);
      const directLayers = asRecordArray(sc.layers);
      const detailLayers = asRecordArray(detail?.layers);
      return {
        id: asString(sc.id, `sc-${idx + 1}`),
        file,
        start: asNumber(sc.start, 0),
        end: asNumber(sc.end, 2),
        title: asString(detail?.title, asString(sc.title, asString(sc.id, `Scene ${idx + 1}`))),
        layers: detailLayers.length > 0 ? detailLayers : directLayers,
      };
    });
    return {
      width: asNumber(obj?.width, 1920),
      height: asNumber(obj?.height, 1080),
      fps: asNumber(obj?.fps, 30),
      duration: Math.max(0.1, asNumber(obj?.duration, 6)),
      background: asString(obj?.background) || tone("side"),
      chapters: asRecordArray(obj?.chapters),
      scenes,
    };
  });

  const safeShotIdx = computed(() => {
    const total = storyboardModel().shots.length;
    if (total === 0) return 0;
    return Math.max(0, Math.min(activeShotIdx(), total - 1));
  });
  const currentShot = computed(() => storyboardModel().shots[safeShotIdx()]);

  effect(() => {
    if (!shotPlaying() || !storyboardAnimatic() || storyboardModel().shots.length === 0) return;
    const shot = currentShot();
    const waitMs = Math.max(900, Math.round((shot?.durationSec ?? 3) * 1000));
    const timer = setTimeout(() => {
      const next = untracked(safeShotIdx) + 1;
      if (next >= storyboardModel().shots.length) {
        shotPlaying.set(false);
        activeShotIdx.set(0);
      } else {
        activeShotIdx.set(next);
      }
    }, waitMs);
    return () => clearTimeout(timer);
  });

  const clampedMotionHead = computed(() => Math.max(0, Math.min(motionModel().duration, motionHead())));
  const activeMotionScene = computed(() => {
    const tSec = clampedMotionHead();
    const scenes = motionModel().scenes;
    return scenes.find((sc) => tSec >= sc.start && tSec < sc.end) ?? scenes.at(-1) ?? scenes.at(0);
  });
  const motionProgress = computed(() => {
    const sc = activeMotionScene();
    if (!sc) return 1;
    const len = Math.max(0.1, sc.end - sc.start);
    return Math.max(0, Math.min(1, (clampedMotionHead() - sc.start) / len));
  });

  useInterval(() => {
    if (!untracked(motionPlaying)) return;
    const next = untracked(motionHead) + 0.05;
    const max = motionModel().duration;
    if (next >= max) {
      if (untracked(motionLoop)) motionHead.set(0);
      else {
        motionHead.set(max);
        motionPlaying.set(false);
      }
    } else {
      motionHead.set(Number(next.toFixed(2)));
    }
  }, 50);

  const togglePlayItem = (item: MediaItemModel) => {
    if (activeAudioId() === item.id) {
      activeAudioId.set(undefined);
      void transport()
        .call("host.stopAudio", {})
        .catch(() => {});
      return;
    }
    if (!item.src) return;
    activeAudioId.set(item.id);
    void playAudio(item.src, 0).catch((e) => {
      toast(reasonOf(e), "bad");
      if (untracked(activeAudioId) === item.id) activeAudioId.set(undefined);
    });
  };

  const exportAssetFile = (meta: NoteFileMeta) => {
    void api.note.file
      .get({ id: props.note.id, path: meta.path, ...(props.version !== undefined ? { version: props.version } : {}) })
      .then((file) => {
        const name = meta.path.split("/").pop() || "asset";
        if (file.encoding === "base64") return saveBase64File(name, file.mime, file.content);
        return saveTextFile(name, file.mime, file.content);
      })
      .then((saved) => {
        if (saved) toast(t("web.base.form.save"));
      })
      .catch((e) => toast(reasonOf(e), "bad"));
  };

  const tabOptions = computed(() => {
    const opts: { value: MediaTabMode; label: string; count?: number }[] = [
      { value: "media", label: t("web.note.types.media"), count: mediaDoc().items.length },
    ];
    if (storyboardModel().shots.length > 0) {
      opts.push({ value: "storyboard", label: "Storyboard", count: storyboardModel().shots.length });
    }
    if (motionModel().scenes.length > 0) {
      opts.push({ value: "motion", label: "Motion", count: motionModel().scenes.length });
    }
    opts.push({ value: "assets", label: t("web.note.page.filesTab"), count: assetFiles().length });
    return opts;
  });

  return (
    <View testID="note-media-view" class="min-h-0 min-w-0 flex-1 bg-page">
      <View class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-3">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Icon name={mediaKindIcon(mediaDoc().mediaKind)} size={14} tone="accent" />
          <Text class="min-w-0 truncate text-sm font-semibold text-ink">{mediaDoc().title}</Text>
          <View class="h-5 items-center justify-center rounded-sm border border-line bg-page px-1.5">
            <Text class="font-mono text-2xs text-muted">{mediaDoc().mediaKind}</Text>
          </View>
          <If when={mediaDoc().durationSec !== undefined}>
            <Text class="font-mono text-2xs text-faint tabular-nums">{`${mediaDoc().durationSec ?? 0}s`}</Text>
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-2">
          <If when={mediaDoc().issueId && props.onOpenIssue !== undefined ? mediaDoc().issueId : undefined}>
            {(issId) => (
              <Button size="compact" tone="plain" icon="issues" testID="media-open-issue" onPress={() => props.onOpenIssue?.(issId())}>
                {issId()}
              </Button>
            )}
          </If>
          <Segmented testid="media-mode-tabs" label={t("web.note.page.viewMode")} value={tabMode()} onChange={(m) => tabMode.set(m)} options={tabOptions()} />
        </View>
      </View>

      <If when={tabMode() === "media"}>
        <Scroll testID="media-items-panel" class="min-h-0 flex-1" contentClass="gap-4 p-4">
          <If when={mediaDoc().caption}>
            {(cap) => (
              <View class="rounded-lg border border-line bg-side px-3.5 py-2.5">
                <Text class="text-xs leading-relaxed text-ink">{cap()}</Text>
              </View>
            )}
          </If>

          <If when={mediaDoc().items.length > 0 || assetFiles().length > 0} else={<Empty icon="media">{t("web.library.empty")}</Empty>}>
            <View class="gap-3">
              <Each of={mediaDoc().items} key={(item) => item.id}>
                {(item) => {
                  const playing = () => activeAudioId() === item().id;
                  return (
                    <View testID={`media-item-${item().id}`} class="gap-2.5 rounded-xl border border-line bg-side p-3.5">
                      <View class="flex-row items-center justify-between gap-2">
                        <View class="min-w-0 flex-1 flex-row items-center gap-2">
                          <View class="size-7 shrink-0 items-center justify-center rounded-md border border-line bg-page">
                            <Icon name={mediaKindIcon(item().kind)} size={14} tone="accent" />
                          </View>
                          <View class="min-w-0 flex-1">
                            <Text class="truncate text-sm font-semibold text-ink">{item().title}</Text>
                            <Text class="truncate font-mono text-2xs text-faint">{item().src || item().kind}</Text>
                          </View>
                        </View>
                        <View class="shrink-0 flex-row items-center gap-1.5">
                          <If when={item().durationSec !== undefined}>
                            <Text class="font-mono text-2xs text-muted tabular-nums">{`${item().durationSec ?? 0}s`}</Text>
                          </If>
                          <If when={item().issueId && props.onOpenIssue !== undefined ? item().issueId : undefined}>
                            {(issId) => (
                              <Button size="compact" tone="quiet" icon="issues" onPress={() => props.onOpenIssue?.(issId())}>
                                {issId()}
                              </Button>
                            )}
                          </If>
                          <If when={item().kind === "audio" && item().src !== ""}>
                            <Button
                              size="compact"
                              tone={playing() ? "danger" : "primary"}
                              icon={playing() ? "stop" : "play"}
                              testID={`media-play-${item().id}`}
                              onPress={() => togglePlayItem(item())}
                            >
                              {playing() ? t("web.base.stop") : t("web.base.play")}
                            </Button>
                          </If>
                        </View>
                      </View>

                      <If when={item().caption}>
                        <Text class="text-xs leading-relaxed text-muted">{item().caption}</Text>
                      </If>

                      <If when={item().transcript.length > 0}>
                        <View testID={`media-transcript-${item().id}`} class="gap-1.5 rounded-lg border border-line bg-page p-2.5">
                          <Each of={item().transcript} key={(cue) => cue.id}>
                            {(cue) => (
                              <View class="flex-row items-start gap-2">
                                <Text class="w-16 shrink-0 font-mono text-2xs text-faint tabular-nums">{`${cue().startSec.toFixed(1)}s`}</Text>
                                <If when={cue().speaker}>
                                  <Text class="shrink-0 text-2xs font-semibold text-accent">{cue().speaker}</Text>
                                </If>
                                <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{cue().text}</Text>
                              </View>
                            )}
                          </Each>
                        </View>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>

          <If when={mediaDoc().topTranscript.length > 0}>
            <View testID="media-top-transcript" class="gap-1.5 rounded-xl border border-line bg-side p-3.5">
              <Each of={mediaDoc().topTranscript} key={(cue) => cue.id}>
                {(cue) => (
                  <View class="flex-row items-start gap-2">
                    <Text class="w-16 shrink-0 font-mono text-2xs text-faint tabular-nums">{`${cue().startSec.toFixed(1)}s`}</Text>
                    <If when={cue().speaker}>
                      <Text class="shrink-0 text-2xs font-semibold text-accent">{cue().speaker}</Text>
                    </If>
                    <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{cue().text}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </Scroll>
      </If>

      <If when={tabMode() === "storyboard"}>
        <Scroll testID="media-storyboard-panel" class="min-h-0 flex-1" contentClass="gap-4 p-4">
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <View class="flex-row items-center gap-2">
              <Text class="font-mono text-xs text-muted">{`${storyboardModel().aspectRatio} · ${storyboardModel().fps} fps`}</Text>
              <If when={storyboardModel().visualTone}>
                <Text class="text-xs text-ink">{storyboardModel().visualTone}</Text>
              </If>
            </View>
            <Button
              size="compact"
              tone={storyboardAnimatic() ? "primary" : "plain"}
              icon={storyboardAnimatic() ? "play" : "catalog"}
              testID="media-storyboard-toggle"
              onPress={() => {
                shotPlaying.set(false);
                storyboardAnimatic.set(!storyboardAnimatic());
              }}
            >
              {storyboardAnimatic() ? "Grid" : "Animatic"}
            </Button>
          </View>

          <If when={storyboardAnimatic() && currentShot() !== undefined}>
            <If when={currentShot()}>
              {(sh) => (
                <View testID="media-storyboard-animatic" class="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-line bg-side shadow-raise">
                  <View class="relative h-60 w-full bg-page">
                    <FramingGuide framing={sh().framing} color={tone("accent")} />
                    <View class="absolute top-3 left-3 rounded-sm border border-line bg-side px-2 py-0.5">
                      <Text class="font-mono text-2xs font-semibold text-ink">{`${sh().id.toUpperCase()} · ${sh().scene}`}</Text>
                    </View>
                    <View class="absolute top-3 right-3 rounded-sm border border-line bg-side px-2 py-0.5">
                      <Text class="font-mono text-2xs text-muted">{`${sh().framing} · ${sh().camera} · ${sh().durationSec}s`}</Text>
                    </View>
                  </View>
                  <View class="flex-row items-center justify-between gap-2 border-t border-line p-3">
                    <View class="flex-row items-center gap-1.5">
                      <IconButton
                        icon="previous"
                        size={14}
                        label={t("web.base.lightbox.prev")}
                        disabled={safeShotIdx() <= 0}
                        onClick={() => {
                          shotPlaying.set(false);
                          activeShotIdx.set(Math.max(0, safeShotIdx() - 1));
                        }}
                      />
                      <Button
                        size="compact"
                        tone={shotPlaying() ? "danger" : "primary"}
                        icon={shotPlaying() ? "stop" : "play"}
                        onPress={() => shotPlaying.set(!shotPlaying())}
                      >
                        {shotPlaying() ? t("web.base.stop") : t("web.base.play")}
                      </Button>
                      <IconButton
                        icon="next"
                        size={14}
                        label={t("web.base.lightbox.next")}
                        disabled={safeShotIdx() >= storyboardModel().shots.length - 1}
                        onClick={() => {
                          shotPlaying.set(false);
                          activeShotIdx.set(Math.min(storyboardModel().shots.length - 1, safeShotIdx() + 1));
                        }}
                      />
                    </View>
                    <Text class="font-mono text-2xs text-muted tabular-nums">{`${safeShotIdx() + 1} / ${storyboardModel().shots.length}`}</Text>
                  </View>
                </View>
              )}
            </If>
          </If>

          <If when={!storyboardAnimatic()}>
            <View class="flex-row flex-wrap gap-3">
              <Each of={storyboardModel().shots} key={(sh) => sh.id}>
                {(sh) => (
                  <View testID={`media-shot-${sh().id}`} class="min-w-68 flex-1 gap-2 rounded-xl border border-line bg-side p-3">
                    <View class="relative h-24 w-full overflow-hidden rounded-md border border-line bg-page">
                      <FramingGuide framing={sh().framing} color={tone("accent")} />
                      <View class="absolute top-1.5 left-1.5 rounded-xs border border-line bg-side px-1.5 py-0.5">
                        <Text class="font-mono text-2xs font-semibold text-ink">{sh().id.toUpperCase()}</Text>
                      </View>
                    </View>
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="truncate text-sm font-semibold text-ink">{sh().scene || "Shot"}</Text>
                      <Text class="font-mono text-2xs text-muted tabular-nums">{`${sh().durationSec}s`}</Text>
                    </View>
                    <If when={sh().visual}>
                      <Text class="text-xs leading-relaxed text-ink">{sh().visual}</Text>
                    </If>
                    <If when={sh().dialogue}>
                      <Text class="text-xs text-muted">{sh().dialogue}</Text>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </Scroll>
      </If>

      <If when={tabMode() === "motion"}>
        <Scroll testID="media-motion-panel" class="min-h-0 flex-1" contentClass="gap-4 p-4">
          <View
            testID="media-motion-stage"
            class="mx-auto h-64 w-full max-w-3xl items-center justify-center overflow-hidden rounded-xl border border-line p-6 shadow-raise"
            style={{ backgroundColor: motionModel().background }}
          >
            <If when={activeMotionScene()}>
              {(sc) => (
                <View class="w-full max-w-xl items-center gap-3">
                  <Each of={sc().layers} key={(l, idx) => asString(l.id, String(idx))}>
                    {(layer, idx) => {
                      const staggered = () => Math.max(0, Math.min(1, motionProgress() - idx() * 0.08));
                      const anim = () => evaluateMotionLayer(layer(), staggered());
                      const text = () => asString(layer().text, asString(layer().label, sc().title));
                      return (
                        <View
                          class="rounded-lg border border-line bg-page px-4 py-2"
                          style={{
                            opacity: anim().opacity,
                            transform: [{ translateY: anim().offsetY }, { scale: anim().scale }],
                          }}
                        >
                          <Text class="text-base font-semibold text-ink">{text()}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              )}
            </If>
          </View>

          <View class="mx-auto w-full max-w-3xl gap-2 rounded-xl border border-line bg-side p-3">
            <View class="h-1.5 w-full overflow-hidden rounded-full bg-page">
              <View class="h-full rounded-full bg-accent" style={{ width: `${Math.round((clampedMotionHead() / motionModel().duration) * 100)}%` }} />
            </View>
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <View class="flex-row items-center gap-1.5">
                <Button
                  size="compact"
                  tone={motionPlaying() ? "danger" : "primary"}
                  icon={motionPlaying() ? "stop" : "play"}
                  testID="media-motion-play"
                  onPress={() => {
                    if (!motionPlaying() && clampedMotionHead() >= motionModel().duration) motionHead.set(0);
                    motionPlaying.set(!motionPlaying());
                  }}
                >
                  {motionPlaying() ? t("web.base.stop") : t("web.base.play")}
                </Button>
                <IconButton
                  icon="refresh"
                  size={14}
                  label={t("web.base.form.reset")}
                  onClick={() => {
                    motionPlaying.set(false);
                    motionHead.set(0);
                  }}
                />
              </View>
              <View class="flex-row items-center gap-3">
                <Toggle label="Loop" checked={motionLoop()} onChange={(v) => motionLoop.set(v)} />
                <Text class="font-mono text-xs text-muted tabular-nums">
                  {`${clampedMotionHead().toFixed(1)}s / ${motionModel().duration.toFixed(1)}s · ${motionModel().width}×${motionModel().height}`}
                </Text>
              </View>
            </View>
          </View>
        </Scroll>
      </If>

      <If when={tabMode() === "assets"}>
        <Scroll testID="media-assets-panel" class="min-h-0 flex-1" contentClass="gap-2 p-4">
          <If when={assetFiles().length > 0} else={<Empty icon="folder">{t("web.library.empty")}</Empty>}>
            <Each of={assetFiles()} key={(f) => f.path}>
              {(file) => (
                <View
                  testID={`media-asset-${file().path}`}
                  class="flex-row items-center justify-between gap-3 rounded-lg border border-line bg-side px-3 py-2.5"
                >
                  <View class="min-w-0 flex-1 flex-row items-center gap-2">
                    <Icon name="file" size={14} tone="muted" />
                    <View class="min-w-0 flex-1">
                      <Text class="truncate font-mono text-xs font-medium text-ink">{file().path}</Text>
                      <Text class="font-mono text-2xs text-faint tabular-nums">{`${file().mime} · ${file().size} B`}</Text>
                    </View>
                  </View>
                  <View class="shrink-0 flex-row items-center gap-1">
                    <CountPill count={file().hash.slice(0, 7)} />
                    <IconButton icon="download" size={14} label={t("web.base.form.save")} onClick={() => exportAssetFile(file())} />
                  </View>
                </View>
              )}
            </Each>
          </If>
        </Scroll>
      </If>
    </View>
  );
}
