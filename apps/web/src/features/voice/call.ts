// Talking to the orchestrator: the server hands out the call (appId, channel, uid, one token) and starts Agora's
// conversational AI agent in it; the page only joins, on the host's line (the phone's) or Agora's Web SDK (agora.ts). The
// microphone stays open, as on the phone: the agent hears when you stop, and you can talk over it. Muting is a button.
// What was said comes over the RTC data stream as captions (captions.ts) and goes to the farm's chat (voice.heard/said).

import { appWording } from "../../base/words";
import type { RtcLine } from "@vibevalley/protocol/host";
import { currentHost } from "../../base/host";
import { VibeValleyApiError } from "@vibevalley/protocol";
import type { VoiceFix } from "@vibevalley/protocol/api";
import { api, reasonOf } from "../../base/api";
import { webRtc } from "./agora";
import { LiveCaptions } from "./captions";
import { prefsNow } from "../../base/prefs";

export type CallPhase = "idle" | "connecting" | "live" | "ending";

class Cancelled extends Error {}

const sendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export class VoiceCall {
  phase: CallPhase = "idle";
  muted = false;
  agentHere = false;
  problem?: string;
  /** The 设置 section the problem is fixed in, when the server says a setting does. */
  problemAt?: VoiceFix;
  /** 0..100: the microphone's level and the orchestrator's. */
  micLevel = 0;
  orchestratorLevel = 0;
  readonly captions = new LiveCaptions();
  version = 0;

  private line?: RtcLine;
  private agentId?: string;
  private starting?: Promise<void>;
  private ending?: Promise<void>;
  private cancel?: () => void;
  private readonly pending: { text: string; owner: boolean; picked?: string; key?: string }[] = [];
  private readonly listeners = new Set<() => void>();

  /** The helper the owner picked to send work to, or undefined for the orchestrator's choice. */
  constructor(private readonly agentPick: () => string | undefined = () => undefined) {
    this.captions.onHeard = (text) => this.caption(text, true);
    this.captions.onAnswered = (text) => this.caption(text, false);
  }

  get agentState() {
    return this.captions.agentState;
  }

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  private changed() {
    this.version++;
    for (const f of this.listeners) f();
  }

  private set(phase: CallPhase, problem?: string | null, at?: VoiceFix) {
    this.phase = phase;
    if (problem !== undefined) {
      this.problem = problem ?? undefined;
      this.problemAt = problem ? at : undefined;
    }
    this.changed();
  }

  /** The owner read the problem and closed it. */
  dismiss() {
    if (this.problem === undefined) return;
    this.problem = undefined;
    this.problemAt = undefined;
    this.changed();
  }

  private caption(text: string, owner: boolean) {
    if (this.phase === "idle" || this.phase === "ending") return;
    const c = { text, owner, ...(owner ? { picked: this.agentPick(), key: sendKey() } : {}) };
    if (this.agentId) this.send(this.agentId, c);
    else this.pending.push(c);
  }

  private send(agentId: string, c: { text: string; owner: boolean; picked?: string; key?: string }) {
    const sent = c.owner
      ? api.voice.heard({ body: { agentId, text: c.text, agent: c.picked ?? null, ...(c.key ? { sendKey: c.key } : {}) } })
      : api.voice.said({ body: { agentId, text: c.text } });
    sent.catch(() => undefined);
  }

  /** about: what rang, when the call answers the phone: the orchestrator says it first. */
  start(about?: string) {
    if (this.phase !== "idle") return Promise.resolve();
    this.starting ??= this.run(about).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async run(about?: string) {
    let cancelled = false;
    const stop = new Promise<never>((_, reject) => (this.cancel = () => ((cancelled = true), reject(new Cancelled()))));
    stop.catch(() => undefined);
    const until = <T>(p: Promise<T>) => Promise.race([p, stop]);
    this.set("connecting", null);
    try {
      const session = await until(api.voice.session());
      let line: RtcLine | undefined;
      const mine = () => !cancelled && this.line === line;
      line = await until(
        (currentHost().rtc ?? webRtc)(session, {
          joined: () => mine() && ((this.agentHere = true), this.changed()),
          left: () => mine() && ((this.agentHere = false), this.changed()),
          stream: (text) => mine() && this.captions.feed(text) && this.changed(),
          levels: (mic, orchestrator) => {
            if (!mine()) return;
            this.micLevel = mic;
            this.orchestratorLevel = orchestrator;
            this.changed();
          },
          problem: (text) => mine() && ((this.problem = text), this.changed()),
          // The token lasts an hour: a fresh one for the same channel and uid before it runs out.
          expiring: () =>
            void (async () => {
              if (!mine()) return;
              try {
                const fresh = await api.voice.renew({ body: { channel: session.channel, uid: session.uid } });
                if (mine()) await line!.renew(fresh.token);
              } catch (e) {
                if (!mine()) return;
                this.problem = appWording().call.renew(reasonOf(e));
                this.changed();
              }
            })(),
        }).then(async (l) => {
          if (cancelled) {
            await l.leave();
            throw new Cancelled();
          }
          return l;
        }),
      );
      this.line = line;
      const agent = await until(
        api.voice.start({ body: { channel: session.channel, uid: session.uid, ...(about ? { about } : {}) } }).then(async (a) => {
          if (cancelled) {
            await this.stopAgent(a.agentId);
            throw new Cancelled();
          }
          return a;
        }),
      );
      this.agentId = agent.agentId;
      for (const c of this.pending.splice(0)) this.send(agent.agentId, c);
      this.set("live");
    } catch (e) {
      await this.teardown();
      if (!cancelled)
        this.set(
          "idle",
          e instanceof Error && e.name === "NotAllowedError" ? appWording().call.noMic : reasonOf(e),
          e instanceof VibeValleyApiError && e.error?._tag === "VoiceUnavailable" ? e.error.settings : undefined,
        );
    }
  }

  toggle() {
    if (this.phase === "idle") return this.start();
    if (this.phase === "connecting" || this.phase === "live") return this.end();
    return Promise.resolve();
  }

  async mute(on: boolean) {
    if (this.phase !== "live" || this.muted === on) return;
    this.muted = on;
    this.changed();
    await this.line?.mute(on);
  }

  end() {
    this.ending ??= (async () => {
      if (this.phase === "idle") return;
      this.set("ending");
      this.cancel?.();
      await this.starting?.catch(() => undefined);
      await this.teardown();
      this.set("idle");
    })().finally(() => (this.ending = undefined));
    return this.ending;
  }

  private async stopAgent(agentId: string) {
    await Promise.race([api.voice.stop({ body: { agentId } }), new Promise((r) => setTimeout(r, 3000))]).catch(() => undefined);
  }

  private async teardown() {
    const agent = this.agentId;
    this.agentId = undefined;
    this.pending.length = 0;
    if (agent) await this.stopAgent(agent);
    const line = this.line;
    this.line = undefined;
    this.muted = false;
    this.agentHere = false;
    this.micLevel = 0;
    this.orchestratorLevel = 0;
    this.captions.clear();
    await line?.leave().catch(() => undefined);
  }
}

/** The farm's one call; what is said in it goes to the helper picked in the farm's chat, if one is. */
export const voiceCall = new VoiceCall(() => {
  const pick = prefsNow().pick;
  return pick && pick !== "auto" ? pick : undefined;
});
