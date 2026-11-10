import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { createExternal } from "#/base/external.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Card } from "#/ui/layout.tsx";
import { Hint, Tip } from "#/ui/Tip.tsx";

import { type MossLine, mossLine, type MossSetup } from "./mossLine";
import { VisionPlayground } from "./VisionPlayground.tsx";
import { canCapture, localRelayHost, type VisualSource } from "./visual-capture.ts";

const recipeStyles = stylex.create({
  mossLineViewP: {
    maxWidth: "80%",
    borderRadius: "var(--radius-lg)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  mossLineViewPVariant1Case1: {
    backgroundColor: "var(--wb-hover)",
  },
  mossLineViewPVariant1Case2: {
    backgroundColor: "var(--wb-ok-soft)",
  },
  mossLineViewPVariant2Case1: {
    fontStyle: null,
  },
  mossLineViewPVariant2Case2: {
    fontStyle: "italic",
  },
});

const variantStyles = stylex.create({
  statSpan: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontVariantNumeric: "tabular-nums",
  },
  statSpanVariant: {
    color: "var(--color-berry)",
  },
  statSpanVariant2: {
    color: "var(--color-ink)",
  },
  mossLineViewDiv: {
    display: "flex",
  },
  mossLineViewDivVariant: {
    justifyContent: "flex-end",
  },
  mossLineViewDivVariant2: {
    justifyContent: "flex-start",
  },
  mossLineViewSpan: {
    marginRight: "calc(var(--spacing) * 1.5)",
  },
  mossLineViewSpanVariant: {
    color: "var(--color-water)",
  },
  mossLineViewSpanVariant2: {
    color: "var(--color-leaf)",
  },
});

const viewStyles = stylex.create({
  debugSummary: {
    cursor: "pointer",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  levelSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  levelSpan2: {
    width: "calc(var(--spacing) * 10)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  levelSpan3: {
    height: "calc(var(--spacing) * 1.5)",
    width: "calc(var(--spacing) * 24)",
    overflow: "hidden",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-hover)",
  },
  levelSpan4: {
    display: "block",
    height: "100%",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-leaf)",
    transitionProperty: "width",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
  },
  statSpan: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
  },
  statSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  mossLine: {
    display: "flex",
    maxWidth: "var(--container-4xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  mossLineViewDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    padding: "calc(var(--spacing) * 4)",
  },
  mossLineViewLabel: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  mossLineViewDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
  mossLineViewP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  mossQos: {
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
    padding: "calc(var(--spacing) * 4)",
  },
  mossSaid: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    padding: "calc(var(--spacing) * 4)",
  },
  mossLineViewP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  mossEvents: {
    maxHeight: "calc(var(--spacing) * 72)",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 3)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  mossLineViewLi: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
});

function Level(props: { value: number; label: string }) {
  return (
    <span {...stylex.attrs(viewStyles.levelSpan)} title={props.label}>
      <span {...stylex.attrs(viewStyles.levelSpan2)}>{props.label}</span>
      <span {...stylex.attrs(viewStyles.levelSpan3)}>
        <span {...stylex.attrs(viewStyles.levelSpan4)} style={{ width: `${props.value}%` }} />
      </span>
    </span>
  );
}

/** One number of the line's quality; what it means on hover. */
function Stat(props: { label: string; value: string; tip: string; bad?: boolean }) {
  return (
    <Tip text={props.tip}>
      <span {...stylex.attrs(viewStyles.statSpan)} tabindex={0}>
        <span {...stylex.attrs(viewStyles.statSpan2)}>{props.label}</span>
        <span {...stylex.attrs(variantStyles.statSpan, props.bad === true ? variantStyles.statSpanVariant : variantStyles.statSpanVariant2)}>
          {props.value}
        </span>
      </span>
    </Tip>
  );
}

export function MossPlayground() {
  const version = createExternal(mossLine.subscribe, () => mossLine.version);
  const [source, setSource] = createSignal<VisualSource>(canCapture("camera") ? "camera" : "screen");
  const line = () => (version(), mossLine);
  onSettled(() => () => mossLine.end());
  return (
    <div {...stylex.attrs(viewStyles.mossLine)}>
      <Show when={!localRelayHost(location.hostname)}>
        <p role="status" {...stylex.attrs(viewStyles.mossLineViewP2)}>
          {t("web.voice.moss.localOnly")}
        </p>
      </Show>
      <VisionPlayground
        source={source()}
        onSource={setSource}
        sharing={line().visualSource !== undefined}
        liveShare={
          <div {...stylex.attrs(viewStyles.mossLineViewDiv)} data-testid="live-visual" data-state={line().visualSource ?? "idle"}>
            <p {...stylex.attrs(viewStyles.mossLineViewP2)}>{t("web.voice.vision.liveTitle")}</p>
            <Show
              when={line().visualSource !== undefined}
              fallback={
                <Button
                  data-testid="live-visual-start"
                  disabled={line().phase !== "live" || !canCapture(source())}
                  onClick={() => void mossLine.startVisual(source())}
                >
                  {t("web.voice.vision.start")}
                </Button>
              }
            >
              <Button data-testid="live-visual-stop" onClick={() => mossLine.stopVisual()}>
                {t("web.voice.vision.stop")}
              </Button>
            </Show>
            <Show when={line().visualProblem}>
              {(problem) => (
                <p role="alert" {...stylex.attrs(viewStyles.mossLineViewP)}>
                  {problem()}
                </p>
              )}
            </Show>
          </div>
        }
      />
      <MossLineView
        enabled={localRelayHost(location.hostname)}
        line={line()}
        onTalk={(setup) => void mossLine.start(setup)}
        onEnd={() => mossLine.end()}
        onMute={(on) => mossLine.mute(on)}
      />
    </div>
  );
}

/** What the line shows, read off the line; the device and the socket stay in mossLine. */
export type MossLineState = Pick<MossLine, "phase" | "problem" | "muted" | "micLevel" | "mossLevel" | "turns" | "events" | "qos">;

/** The playground as it looks at any moment of a call: what MossPlayground draws, and its stories. */
export function MossLineView(props: {
  line: MossLineState;
  enabled?: boolean;
  onTalk: (setup: MossSetup) => void;
  onEnd: () => void;
  onMute: (on: boolean) => void;
}) {
  const line = () => props.line;
  const [persona, setPersona] = createSignal("");
  const [instructions, setInstructions] = createSignal(t("web.voice.moss.defaultInstructions"));
  const idle = () => line().phase === "idle";
  return (
    <div {...stylex.attrs(viewStyles.mossLine)} data-testid="moss-line" data-state={line().phase}>
      <Card title={t("web.voice.moss.tryIt")} action={<span {...stylex.attrs(viewStyles.statSpan2)}>{t("web.voice.moss.notInChat")}</span>}>
        <div {...stylex.attrs(viewStyles.mossLineViewDiv)}>
          <label {...stylex.attrs(viewStyles.mossLineViewLabel)}>
            {t("web.voice.moss.persona")}
            <TextArea
              rows={2}
              disabled={!idle()}
              placeholder={t("web.voice.moss.personaHint")}
              value={persona()}
              onInput={(e) => setPersona(e.currentTarget.value)}
            />
          </label>
          <label {...stylex.attrs(viewStyles.mossLineViewLabel)}>
            {t("web.voice.moss.instructions")}
            <TextArea rows={2} disabled={!idle()} value={instructions()} onInput={(e) => setInstructions(e.currentTarget.value)} />
          </label>
          <div {...stylex.attrs(viewStyles.mossLineViewDiv2)}>
            <Show
              when={idle()}
              fallback={
                <Button tone="danger" icon="stop" data-testid="moss-hang-up" onClick={() => props.onEnd()}>
                  {line().phase === "connecting" ? t("web.voice.moss.connecting") : t("web.voice.moss.hangUp")}
                </Button>
              }
            >
              <Button
                tone="primary"
                icon="record"
                data-testid="moss-talk"
                disabled={props.enabled === false}
                onClick={() => props.onTalk({ persona: persona(), instructions: instructions() })}
              >
                {t("web.voice.moss.talk")}
              </Button>
            </Show>
            <Show when={line().phase === "live"}>
              <IconButton
                icon="record"
                pressed={line().muted}
                label={line().muted ? t("web.voice.moss.unmute") : t("web.voice.moss.mute")}
                onClick={() => props.onMute(!line().muted)}
              />
              <Level value={line().micLevel} label={t("web.voice.moss.you")} />
              <Level value={line().mossLevel} label="MOSS" />
            </Show>
          </div>
          <Show when={line().problem}>
            {(p) => (
              <p role="alert" {...stylex.attrs(viewStyles.mossLineViewP)}>
                {p()}
              </p>
            )}
          </Show>
        </div>
      </Card>
      <Card title={t("web.voice.moss.said")}>
        <div {...stylex.attrs(viewStyles.mossSaid)} role="log" aria-label={t("web.voice.moss.said")} data-testid="moss-said">
          <Show when={line().turns.length > 0} fallback={<p {...stylex.attrs(viewStyles.mossLineViewP2)}>{t("web.voice.moss.nothingSaid")}</p>}>
            <For each={line().turns}>
              {(turn) => (
                <div
                  {...stylex.attrs(
                    variantStyles.mossLineViewDiv,
                    turn.who === "user" ? variantStyles.mossLineViewDivVariant : variantStyles.mossLineViewDivVariant2,
                  )}
                >
                  <p
                    {...stylex.attrs(
                      recipeStyles.mossLineViewP,
                      turn.who === "user" ? recipeStyles.mossLineViewPVariant1Case2 : recipeStyles.mossLineViewPVariant1Case1,
                      !turn.done ? recipeStyles.mossLineViewPVariant2Case2 : recipeStyles.mossLineViewPVariant2Case1,
                    )}
                    data-done={turn.done ? "" : undefined}
                  >
                    {turn.text}
                  </p>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Card>
      {/* What the line does underneath, for when a call goes wrong: folded until asked for. */}
      <details data-testid="moss-debug">
        <summary {...stylex.attrs(viewStyles.debugSummary)}>{t("web.voice.moss.debug")}</summary>
        <div {...stylex.attrs(viewStyles.mossLine)}>
          <Card title={t("web.voice.moss.qos.title")} action={<Hint text={t("web.voice.moss.qos.hint")} />}>
            <div {...stylex.attrs(viewStyles.mossQos)} role="group" aria-label={t("web.voice.moss.qos.title")} data-testid="moss-qos">
              <Stat
                label={t("web.voice.moss.qos.reply")}
                value={
                  line().qos.replyMs === undefined ? "—" : t("web.voice.moss.qos.ms", { last: line().qos.replyMs ?? 0, mean: line().qos.replyMeanMs ?? 0 })
                }
                tip={t("web.voice.moss.qos.replyTip", { n: line().qos.replies })}
                bad={(line().qos.replyMs ?? 0) > 2500}
              />
              <Stat label={t("web.voice.moss.qos.up")} value={`${line().qos.upKbps} kbps`} tip={t("web.voice.moss.qos.upTip")} />
              <Stat label={t("web.voice.moss.qos.down")} value={`${line().qos.downKbps} kbps`} tip={t("web.voice.moss.qos.downTip")} />
              <Stat
                label={t("web.voice.moss.qos.frames")}
                value={`${line().qos.framesPerSecond}/s`}
                tip={t("web.voice.moss.qos.framesTip")}
                bad={line().phase === "live" && line().qos.framesPerSecond < 45}
              />
              <Stat
                label={t("web.voice.moss.qos.backlog")}
                value={`${line().qos.backlog} B`}
                tip={t("web.voice.moss.qos.backlogTip")}
                bad={line().qos.backlog > 16000}
              />
              <Stat label={t("web.voice.moss.qos.ahead")} value={`${line().qos.aheadMs} ms`} tip={t("web.voice.moss.qos.aheadTip")} />
              <Stat label={t("web.voice.moss.qos.gaps")} value={String(line().qos.gaps)} tip={t("web.voice.moss.qos.gapsTip")} bad={line().qos.gaps > 0} />
              <Stat
                label={t("web.voice.moss.qos.stops")}
                value={String(Object.values(line().qos.stops).reduce((a, b) => a + b, 0))}
                tip={
                  Object.keys(line().qos.stops).length === 0
                    ? t("web.voice.moss.qos.stopsTip")
                    : Object.entries(line().qos.stops)
                        .map(([why, n]) => `${why} × ${n}`)
                        .join("\n")
                }
                bad={Object.keys(line().qos.stops).length > 0}
              />
            </div>
          </Card>
          <Card title={t("web.voice.moss.events")} action={<Hint text={t("web.voice.moss.eventsHint")} />}>
            <ol {...stylex.attrs(viewStyles.mossEvents)} aria-label={t("web.voice.moss.events")} data-testid="moss-events">
              <For each={line().events}>
                {(e) => (
                  <li {...stylex.attrs(viewStyles.mossLineViewLi)} title={e.text}>
                    <span
                      {...stylex.attrs(variantStyles.mossLineViewSpan, e.up ? variantStyles.mossLineViewSpanVariant : variantStyles.mossLineViewSpanVariant2)}
                    >
                      {e.up ? t("web.voice.moss.up") : t("web.voice.moss.down")}
                    </span>
                    {e.text}
                  </li>
                )}
              </For>
            </ol>
          </Card>
        </div>
      </details>
    </div>
  );
}
