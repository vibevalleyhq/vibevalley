import { t } from "@vibevalley/i18n";
// 设置 › MOSS Live: talk to MOSS Live on its own, to hear how it answers. What was said, and every action and event
// on the line, are shown as they come; nothing goes to the farm's chat.

import { createSignal, For, Show } from "solid-js";
import { createExternal } from "../../base/external";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { IconButton } from "../../ui/IconButton";
import { Card } from "../../ui/layout";
import { Hint, Tip } from "../../ui/Tip";
import { type MossLine, mossLine, type MossSetup } from "./mossLine";

function Level(props: { value: number; label: string }) {
  return (
    <span class="flex items-center gap-1.5 text-xs text-muted" title={props.label}>
      <span class="w-10 truncate">{props.label}</span>
      <span class="h-1.5 w-24 overflow-hidden rounded-full bg-hover">
        <span class="block h-full rounded-full bg-leaf transition-[width] duration-120" style={{ width: `${props.value}%` }} />
      </span>
    </span>
  );
}

/** One number of the line's quality; what it means on hover. */
function Stat(props: { label: string; value: string; tip: string; bad?: boolean }) {
  return (
    <Tip text={props.tip}>
      <span class="flex flex-col rounded-md border border-line px-2.5 py-1.5" tabindex={0}>
        <span class="text-xs text-muted">{props.label}</span>
        <span class={["font-mono text-sm tabular-nums", props.bad ? "text-berry" : "text-ink"]}>{props.value}</span>
      </span>
    </Tip>
  );
}

export function MossPlayground() {
  const version = createExternal(mossLine.subscribe, () => mossLine.version);
  return (
    <MossLineView line={(version(), mossLine)} onTalk={(setup) => void mossLine.start(setup)} onEnd={() => mossLine.end()} onMute={(on) => mossLine.mute(on)} />
  );
}

/** What the line shows, read off the line; the device and the socket stay in mossLine. */
export type MossLineState = Pick<MossLine, "phase" | "problem" | "muted" | "micLevel" | "mossLevel" | "turns" | "events" | "qos">;

/** The playground as it looks at any moment of a call: what MossPlayground draws, and its stories. */
export function MossLineView(props: { line: MossLineState; onTalk: (setup: MossSetup) => void; onEnd: () => void; onMute: (on: boolean) => void }) {
  const line = () => props.line;
  const [persona, setPersona] = createSignal("");
  const [instructions, setInstructions] = createSignal(t("web.voice.moss.defaultInstructions"));
  const idle = () => line().phase === "idle";
  return (
    <div class="flex max-w-4xl flex-col gap-3" data-testid="moss-line" data-state={line().phase}>
      <Card title={t("web.voice.moss.tryIt")} action={<span class="text-xs text-muted">{t("web.voice.moss.notInChat")}</span>}>
        <div class="flex flex-col gap-3 p-4">
          <label class="flex flex-col gap-1 text-xs font-medium text-muted">
            {t("web.voice.moss.persona")}
            <TextArea
              rows={2}
              disabled={!idle()}
              placeholder={t("web.voice.moss.personaHint")}
              value={persona()}
              onInput={(e) => setPersona(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-xs font-medium text-muted">
            {t("web.voice.moss.instructions")}
            <TextArea rows={2} disabled={!idle()} value={instructions()} onInput={(e) => setInstructions(e.currentTarget.value)} />
          </label>
          <div class="flex flex-wrap items-center gap-3">
            <Show
              when={idle()}
              fallback={
                <Button tone="danger" icon="stop" data-testid="moss-hang-up" onClick={() => props.onEnd()}>
                  {line().phase === "connecting" ? t("web.voice.moss.connecting") : t("web.voice.moss.hangUp")}
                </Button>
              }
            >
              <Button tone="primary" icon="record" data-testid="moss-talk" onClick={() => props.onTalk({ persona: persona(), instructions: instructions() })}>
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
              <p role="alert" class="text-sm text-berry">
                {p()}
              </p>
            )}
          </Show>
        </div>
      </Card>
      <Card title={t("web.voice.moss.qos.title")} action={<Hint text={t("web.voice.moss.qos.hint")} />}>
        <div class="flex flex-wrap gap-2 p-4" role="group" aria-label={t("web.voice.moss.qos.title")} data-testid="moss-qos">
          <Stat
            label={t("web.voice.moss.qos.reply")}
            value={line().qos.replyMs === undefined ? "—" : t("web.voice.moss.qos.ms", { last: line().qos.replyMs!, mean: line().qos.replyMeanMs! })}
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
      <Card title={t("web.voice.moss.said")}>
        <div class="flex flex-col gap-2 p-4" role="log" aria-label={t("web.voice.moss.said")} data-testid="moss-said">
          <Show when={line().turns.length > 0} fallback={<p class="text-sm text-muted">{t("web.voice.moss.nothingSaid")}</p>}>
            <For each={line().turns}>
              {(turn) => (
                <div class={["flex", turn.who === "owner" ? "justify-end" : "justify-start"]}>
                  <p
                    class={["max-w-[80%] rounded-lg px-3 py-1.5 text-sm", turn.who === "owner" ? "bg-ok-soft" : "bg-hover", { italic: !turn.done }]}
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
      <Card title={t("web.voice.moss.events")} action={<Hint text={t("web.voice.moss.eventsHint")} />}>
        <ol class="max-h-72 overflow-y-auto p-3 font-mono text-xs" aria-label={t("web.voice.moss.events")} data-testid="moss-events">
          <For each={line().events}>
            {(e) => (
              <li class="truncate" title={e.text}>
                <span class={["mr-1.5", e.up ? "text-water" : "text-leaf"]}>{e.up ? t("web.voice.moss.up") : t("web.voice.moss.down")}</span>
                {e.text}
              </li>
            )}
          </For>
        </ol>
      </Card>
    </div>
  );
}
