import { t } from "@vibevalley/i18n";
import type { VoiceFix } from "@vibevalley/protocol/api";
import type { Rtc, RtcLine } from "@vibevalley/protocol/host";

import { messageOf } from "#/base/format.ts";
import { api, faultOf, reasonOf } from "#/infra/api.ts";
import { currentHost } from "#/infra/host.ts";
import { prefsNow } from "#/state/prefs.ts";

import { LiveCaptions, voiceTurnsOfCaptions } from "./captions";
import { type VoiceDriver, type VoicePhase, type VoiceTurn } from "./contract.ts";
import { MossLine } from "./moss-line.ts";

// A call's line on MOSS Live over local WebSocket (/api/v1/voice/moss/line): needs no Agora credentials or tunnel.
const mossRtc =
  (signal: AbortSignal): Rtc =>
  async (_grant, on) => {
    const moss = new MossLine({
      closed: () => t("web.voice.moss.closed"),
      noMic: () => t("web.voice.call.noMic"),
      formatError: messageOf,
    });
    let connected = false;
    let gone = false;
    let lastMic = 0;
    let lastMoss = 0;
    let lastState = "";
    let nextTurnId = 1;
    const sentTurns = new Map<string, { id: number; text: string; done: boolean }>();

    return new Promise<RtcLine>((resolve, reject) => {
      const abort = () => moss.end();
      const off = moss.subscribe(() => {
        if (gone) return;
        if (moss.micLevel !== lastMic || moss.mossLevel !== lastMoss) {
          lastMic = moss.micLevel;
          lastMoss = moss.mossLevel;
          on.levels(lastMic, lastMoss);
        }
        const nextState = moss.mossLevel > 0 ? "speaking" : "listening";
        if (connected && nextState !== lastState) {
          lastState = nextState;
          on.stream(JSON.stringify({ object: "message.state", state: nextState }));
        }
        moss.turns.forEach((turn) => {
          const key = `${turn.who}:${turn.key}`;
          let prev = sentTurns.get(key);
          if (!prev && turn.key) {
            const unnamedKey = `${turn.who}:`;
            const unnamed = sentTurns.get(unnamedKey);
            if (unnamed && !moss.turns.some((entry) => entry.who === turn.who && !entry.key)) {
              prev = unnamed;
              sentTurns.delete(unnamedKey);
              sentTurns.set(key, unnamed);
            }
          }
          if (prev && prev.text === turn.text && prev.done === turn.done) return;
          const turnId = prev?.id ?? nextTurnId++;
          sentTurns.set(key, { id: turnId, text: turn.text, done: turn.done });
          if (turn.who === "owner") {
            on.stream(
              JSON.stringify({
                object: "user.transcription",
                turn_id: turnId,
                text: turn.text,
                final: turn.done,
              }),
            );
          } else {
            on.stream(
              JSON.stringify({
                object: "assistant.transcription",
                turn_id: turnId,
                text: turn.text,
                turn_status: turn.done ? 1 : 0,
              }),
            );
          }
        });
        while (sentTurns.size > moss.turns.length) {
          const oldest = sentTurns.keys().next().value;
          if (oldest === undefined) break;
          sentTurns.delete(oldest);
        }

        if (!connected && moss.phase === "live") {
          connected = true;
          signal.removeEventListener("abort", abort);
          on.joined();
          resolve({
            mute: async (muted) => {
              moss.mute(muted);
            },
            renew: async () => {},
            leave: async () => {
              gone = true;
              off();
              moss.end();
            },
          });
        } else if (moss.phase === "idle") {
          signal.removeEventListener("abort", abort);
          off();
          if (!connected) {
            reject(new Error(moss.problem || t("web.voice.moss.closed")));
          } else if (!gone) {
            if (moss.problem) on.problem(moss.problem);
            on.left();
          }
        }
      });
      if (signal.aborted) {
        off();
        reject(new Cancelled());
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      void moss.start({ persona: "", instructions: "" });
    });
  };

// A call's line on Agora's Web SDK, loaded when a call starts: the page's own, where the host carries none (the desktop, a browser).
const webRtc: Rtc = async (grant, on) => {
  const AgoraRTC = (await import("agora-rtc-sdk-ng")).default;
  AgoraRTC.setLogLevel(3);
  const client = AgoraRTC.createClient({ mode: "live", codec: "vp8" });
  let gone = false;
  client.on("user-joined", () => !gone && on.joined());
  client.on("user-left", () => !gone && on.left());
  client.on("user-published", (user, media) => {
    if (gone || media !== "audio") return;
    client.subscribe(user, "audio").then(
      () => user.audioTrack?.play(),
      (e: unknown) => !gone && on.problem(t("web.voice.call.cannotHear", { why: messageOf(e) })),
    );
  });
  client.on("stream-message", (_uid: unknown, payload: Uint8Array) => !gone && on.stream(new TextDecoder().decode(payload)));
  client.on("volume-indicator", (levels: { uid: string | number; level: number }[]) => {
    if (gone) return;
    let mine = 0;
    let theirs = 0;
    for (const l of levels) {
      if (String(l.uid) === grant.uid) mine = l.level;
      else theirs = l.level;
    }
    on.levels(mine, theirs);
  });
  client.on("exception", (e: { code: number; msg: string }) => !gone && on.problem(t("web.voice.call.agora", { code: e.code, msg: e.msg })));
  client.on("token-privilege-will-expire", () => !gone && on.expiring());
  const leave = async () => {
    gone = true;
    mic?.close();
    await client.leave().catch(() => undefined);
  };
  let mic: Awaited<ReturnType<typeof AgoraRTC.createMicrophoneAudioTrack>> | undefined;
  try {
    await client.setClientRole("host");
    client.enableAudioVolumeIndicator();
    // Joined with the number the uid string holds: the agent listens to that uid only.
    await client.join(grant.appId, grant.channel, grant.token, Number(grant.uid));
    // Echo cancellation, noise suppression and gain on, as a quiet laptop microphone otherwise reaches the agent too quietly for its voice detection to hear anyone talk.
    mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    await client.publish(mic);
  } catch (e) {
    await leave();
    throw e;
  }
  return {
    mute: async (on) => {
      await mic.setMuted(on);
    },
    renew: (token) => client.renewToken(token),
    leave,
  };
};

export type CallPhase = VoicePhase;

// Rejects the Promise a call's setup races against when the owner hangs up; the page's call code is not Effect.
// @effect-diagnostics-next-line extendsNativeError:off
class Cancelled extends Error {}

const sendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export class VoiceCall implements VoiceDriver<string | undefined, "owner" | "orchestrator"> {
  phase: CallPhase = "idle";
  muted = false;
  agentHere = false;
  problem = "";
  /** The Settings section the problem is fixed in, when the server says a setting does. */
  problemAt: VoiceFix | undefined = undefined;
  /** 0..100: the microphone's level and the orchestrator's. */
  micLevel = 0;
  orchestratorLevel = 0;
  readonly captions = new LiveCaptions();
  version = 0;

  private line: RtcLine | undefined = undefined;
  private agentId: string | undefined = undefined;
  private starting: Promise<void> | undefined = undefined;
  private ending: Promise<void> | undefined = undefined;
  private cancel?: () => void;
  private readonly pending: { text: string; owner: boolean; picked?: string | undefined; key?: string }[] = [];
  private readonly listeners = new Set<() => void>();

  /** The helper the owner picked to send work to, or undefined for the orchestrator's choice. */
  private readonly agentPick: () => string | undefined;
  constructor(agentPick: () => string | undefined = () => undefined) {
    this.agentPick = agentPick;
    this.captions.onHeard = (text) => this.caption(text, true);
    this.captions.onAnswered = (text) => this.caption(text, false);
  }

  get inputLevel(): number {
    return this.micLevel;
  }

  get outputLevel(): number {
    return this.orchestratorLevel;
  }

  get turns(): readonly VoiceTurn<"owner" | "orchestrator">[] {
    return voiceTurnsOfCaptions(this.captions.turns);
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

  /** problem: "" clears it; left out, it stays. */
  private set(phase: CallPhase, problem?: string, at?: VoiceFix) {
    this.phase = phase;
    if (problem !== undefined) {
      this.problem = problem;
      this.problemAt = problem ? at : undefined;
    }
    this.changed();
  }

  /** The owner read the problem and closed it. */
  dismiss() {
    if (this.problem === "") return;
    this.problem = "";
    this.problemAt = undefined;
    this.changed();
  }

  private caption(text: string, owner: boolean) {
    if (this.phase === "idle" || this.phase === "ending") return;
    const c = { text, owner, ...(owner ? { picked: this.agentPick(), key: sendKey() } : {}) };
    if (this.agentId) this.send(agentIdOf(this.agentId), c);
    else this.pending.push(c);
  }

  private send(agentId: string, c: { text: string; owner: boolean; picked?: string | undefined; key?: string }) {
    const sent = c.owner
      ? api.voice.call.hear({ agentId, text: c.text, ...(c.picked ? { agent: c.picked } : {}), ...(c.key ? { sendKey: c.key } : {}) })
      : api.voice.call.say({ agentId, text: c.text });
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
    const controller = new AbortController();
    const stop = new Promise<never>((_resolve, reject) => {
      this.cancel = () => {
        cancelled = true;
        controller.abort();
        reject(new Cancelled());
      };
    });
    stop.catch(() => undefined);
    const until = <T>(p: Promise<T>) => Promise.race([p, stop]);
    this.set("connecting", "");
    try {
      const session = await until(api.voice.grant.create());
      let line: RtcLine | undefined;
      const mine = () => !cancelled && this.line === line;
      const transport = session.appId === "moss" ? mossRtc(controller.signal) : (currentHost().rtc ?? webRtc);
      line = await until(
        transport(session, {
          joined: () => mine() && ((this.agentHere = true), this.changed()),
          left: () => {
            if (!mine()) return;
            this.agentHere = false;
            if (session.appId === "moss") void this.end();
            else this.changed();
          },
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
                const fresh = await api.voice.grant.renew({ channel: session.channel, uid: session.uid });
                if (mine()) await line?.renew(fresh.token);
              } catch (e) {
                if (!mine()) return;
                this.problem = t("web.voice.call.renew", { why: reasonOf(e) });
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
      if (session.appId === "moss") this.agentHere = true;
      const agent = await until(
        api.voice.call.start({ channel: session.channel, uid: session.uid, ...(about ? { about } : {}) }).then(async (a) => {
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
      if (!cancelled) {
        const fault = faultOf(e);
        this.set("idle", e instanceof Error && e.name === "NotAllowedError" ? t("web.voice.call.noMic") : fault.reason, fault.settings);
      }
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
    await Promise.race([api.voice.call.stop({ agentId }), new Promise((r) => setTimeout(r, 3000))]).catch(() => undefined);
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

const agentIdOf = (id: string) => id;

/** The farm's one call; what is said in it goes to the helper picked in the farm's chat, if one is. */
export const voiceCall = new VoiceCall(() => {
  const pick = prefsNow().pick;
  return pick && pick !== "auto" ? pick : undefined;
});
