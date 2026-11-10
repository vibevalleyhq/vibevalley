import type { VoiceTurn as TranscriptTurn } from "@vibevalley/ai/realtime/turns";

export type VoicePhase = "idle" | "connecting" | "live" | "ending";

export type VoiceSpeaker = "user" | "moss" | "orchestrator";

export type VoiceTurn<Who extends string = VoiceSpeaker> = TranscriptTurn<Who>;

export interface VoiceDriver<Setup = void, Who extends string = VoiceSpeaker> {
  readonly phase: VoicePhase;
  readonly muted: boolean;
  /** 0..100 microphone loudness level. */
  readonly inputLevel: number;
  /** 0..100 remote / assistant loudness level. */
  readonly outputLevel: number;
  readonly turns: readonly VoiceTurn<Who>[];
  readonly problem: string | undefined;
  readonly version: number;
  readonly subscribe: (listener: () => void) => () => void;
  start(setup: Setup): Promise<void>;
  mute(on: boolean): void | Promise<void>;
  end(): void | Promise<void>;
}
