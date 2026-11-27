import { cleanup, signal } from "nsh";

import type { Agent, ChatMessage, MediaSpeechRequest, ProviderStatus } from "@vibevalley/protocol";

import { api } from "../../../infra/api";
import { followed } from "../../../infra/channelFollow";
import { providerQuery, ready, useAgents, useQuery } from "../../../infra/query";
import { createEffect } from "../../../infra/solid";
import { playSpeech } from "../../media";

export const listenToReports = signal(false);

export interface ReportPlaybackRequest {
  readonly key: string;
  readonly text: string;
  readonly voice: string;
  readonly connection: string;
  readonly revision: number;
}

type SynthesizeSpeech = (req: MediaSpeechRequest) => Promise<{ id: string }>;
type PlaySpeechStream = (id: string, changed: (state: "playing" | "done" | "finished") => void, failed: (error: string) => void) => () => void;

/** Strips Markdown syntax and bounds length for natural spoken report synthesis. */
export function sanitizeReportForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/^[#>*\-\s]+/gmu, "")
    .replace(/[*_~]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2000);
}

/** True when a message is a non-deleted worker report carrying speakable content. */
export function isWorkerReportMessage(message: ChatMessage): boolean {
  return (
    message.kind === "report" &&
    message.deleted === undefined &&
    message.actor.kind === "agent" &&
    message.actor.role === "worker" &&
    sanitizeReportForSpeech(message.text).length > 0
  );
}

/** Resolves an enabled Speech connection and the worker agent's assigned voice; returns undefined to silently skip. */
export function resolveReportVoiceTarget(
  message: ChatMessage,
  agents: readonly Agent[],
  provider: ProviderStatus | undefined,
): ReportPlaybackRequest | undefined {
  if (!isWorkerReportMessage(message) || !provider?.speech) return undefined;
  const speechBinding = provider.speech;
  if (!speechBinding.model.startsWith("moss-tts-1.5-flash")) return undefined;
  const conn = provider.connections.find((c) => c.id === speechBinding.connection);
  if (!conn || !conn.enabled || conn.key.source === null) return undefined;

  const agentId = message.agent ?? message.from;
  const agent = agents.find((a) => a.id === agentId);
  const voice = agent?.voice?.trim();
  if (!voice) return undefined;

  const text = sanitizeReportForSpeech(message.text);
  if (!text) return undefined;
  return {
    key: `${message.channel}:${message.number}`,
    text,
    voice,
    connection: speechBinding.connection,
    revision: provider.revision,
  };
}

/**
 * FIFO serialized audio playback queue for worker channel reports.
 * Never overlaps playback, silently skips synthesis or device errors (e.g. when a MOSS Live call holds audio),
 * and clears pending items cleanly on stop.
 */
export class SerializedReportQueue {
  private readonly items: ReportPlaybackRequest[] = [];
  private readonly seen = new Set<string>();
  private draining = false;
  private generation = 0;
  private stopCurrent: (() => void) | undefined;

  constructor(
    private readonly isEnabled: () => boolean,
    private readonly synthesize: SynthesizeSpeech = (req) => api.media.speech.create(req),
    private readonly playStream: PlaySpeechStream = playSpeech,
    private readonly onIdle?: () => void,
  ) {}

  get pendingCount(): number {
    return this.items.length;
  }

  get active(): boolean {
    return this.draining;
  }

  enqueue(item: ReportPlaybackRequest): boolean {
    if (!this.isEnabled() || this.seen.has(item.key)) return false;
    this.seen.add(item.key);
    this.items.push(item);
    if (!this.draining) {
      void this.drain();
    }
    return true;
  }

  stopAll(): void {
    this.generation++;
    this.items.length = 0;
    const stop = this.stopCurrent;
    this.stopCurrent = undefined;
    stop?.();
  }

  resetSeen(): void {
    this.seen.clear();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const myGen = this.generation;
    try {
      while (this.items.length > 0 && myGen === this.generation && this.isEnabled()) {
        const next = this.items.shift()!;
        await this.playOne(next, myGen);
      }
    } finally {
      this.draining = false;
      this.stopCurrent = undefined;
      this.onIdle?.();
    }
  }

  private async playOne(item: ReportPlaybackRequest, gen: number): Promise<void> {
    let jobId: string;
    try {
      const job = await this.synthesize({
        id: crypto.randomUUID(),
        text: item.text,
        voice: item.voice,
        format: "pcm",
        asynchronous: false,
        streaming: true,
        connection: item.connection,
        revision: item.revision,
      });
      jobId = job.id;
    } catch {
      // Missing key or vendor failure must silently skip without interrupting text reading.
      return;
    }
    if (gen !== this.generation || !this.isEnabled()) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.stopCurrent = undefined;
        resolve();
      };
      const stop = this.playStream(
        jobId,
        (state) => {
          if (state === "finished" || gen !== this.generation || !this.isEnabled()) {
            done();
          }
        },
        () => {
          // Host audio refusal (e.g. active MOSS Live call holding output) silently skips.
          done();
        },
      );
      if (gen !== this.generation || !this.isEnabled()) {
        stop();
        done();
      } else {
        this.stopCurrent = () => {
          stop();
          done();
        };
      }
    });
  }
}

export function setListenToReports(enabled: boolean): void {
  listenToReports.set(enabled);
}

/**
 * Watches incoming messages on the active channel while "Listen to reports" is enabled
 * and plays helper reports sequentially through `host.speechStart` using each helper's `Agent.voice`.
 */
export function useChannelReportPlayback(channelId: () => string | undefined): void {
  const agents = useAgents();
  const providers = useQuery(providerQuery);
  const queue = new SerializedReportQueue(() => listenToReports());
  let watermark: { channel: string; number: number } | undefined;

  createEffect(
    () => (listenToReports() ? channelId() : undefined),
    (id) => {
      if (!id) {
        watermark = undefined;
        queue.stopAll();
        queue.resetSeen();
        return;
      }
      const existing = followed.get(id).messages;
      const latest = existing.reduce((max, m) => Math.max(max, m.number), 0);
      watermark = { channel: id, number: latest };

      const checkIncoming = () => {
        if (!listenToReports() || !watermark || watermark.channel !== id) return;
        const currentAgents = ready(agents, []);
        const currentProvider = ready(providers, undefined);
        const list = followed.get(id).messages;
        for (const msg of list) {
          if (msg.number <= watermark.number) continue;
          watermark = { channel: id, number: msg.number };
          const req = resolveReportVoiceTarget(msg, currentAgents, currentProvider);
          if (req) queue.enqueue(req);
        }
      };

      const unsub = followed.subscribe(id, checkIncoming);
      return () => {
        unsub();
        queue.stopAll();
      };
    },
  );

  cleanup(() => queue.stopAll());
}
