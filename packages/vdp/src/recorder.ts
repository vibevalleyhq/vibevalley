import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { z } from "zod";

import { runFfmpeg } from "./process.ts";

export const ScenarioRecordingRecordSchema = z.object({
  id: z.string(),
  label: z.string(),
  scenario: z.string(),
  fps: z.number().positive(),
  frameCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  videoRelPath: z.string().nullable(),
  videoBytes: z.number().int().nonnegative().nullable(),
  framesRelPaths: z.array(z.string()),
});

export type ScenarioRecordingRecord = z.infer<typeof ScenarioRecordingRecordSchema>;

export interface RecordingDriver {
  captureScreenshot(outPath: string, target?: "shell" | "webview"): Promise<{ readonly bytes: number }>;
  settle(ms: number): Promise<void>;
}

export class VdpRecorder {
  readonly id: string;
  readonly label: string;
  readonly scenario: string;
  readonly fps: number;
  private readonly outDir: string;
  private readonly framesDir: string;
  private readonly framesDirRel: string;
  private readonly driver: RecordingDriver;
  private readonly startedAt = Date.now();
  private readonly frameFiles: string[] = [];

  constructor(opts: {
    readonly id: string;
    readonly label: string;
    readonly scenario: string;
    readonly outDir: string;
    readonly driver: RecordingDriver;
    readonly fps?: number | undefined;
  }) {
    const cleanId = opts.id.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-") || "recording";
    this.id = cleanId;
    this.label = opts.label;
    this.scenario = opts.scenario;
    this.fps = Math.max(1, opts.fps ?? 4);
    this.outDir = opts.outDir;
    this.framesDirRel = join("recordings", cleanId);
    this.framesDir = resolve(opts.outDir, this.framesDirRel);
    this.driver = opts.driver;
    mkdirSync(this.framesDir, { recursive: true });
  }

  async captureFrame(settleMs = 60): Promise<string> {
    if (settleMs > 0) {
      await this.driver.settle(settleMs);
    }
    const index = this.frameFiles.length + 1;
    const filename = `frame-${String(index).padStart(4, "0")}.png`;
    const absPath = join(this.framesDir, filename);
    await this.driver.captureScreenshot(absPath, "shell");
    const relPath = join(this.framesDirRel, filename).replaceAll("\\", "/");
    this.frameFiles.push(relPath);
    return absPath;
  }

  finalize(): ScenarioRecordingRecord {
    let videoRelPath: string | null = null;
    let videoBytes: number | null = null;

    if (this.frameFiles.length > 0) {
      const mp4Name = `${this.id}.mp4`;
      const mp4Abs = resolve(this.outDir, mp4Name);
      const ok = runFfmpeg([
        "-y",
        "-framerate",
        String(this.fps),
        "-i",
        join(this.framesDir, "frame-%04d.png"),
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
        mp4Abs,
      ]);
      if (ok && existsSync(mp4Abs)) {
        const size = statSync(mp4Abs).size;
        if (size > 0) {
          videoRelPath = basename(mp4Abs);
          videoBytes = size;
        }
      }
    }

    return ScenarioRecordingRecordSchema.parse({
      id: this.id,
      label: this.label,
      scenario: this.scenario,
      fps: this.fps,
      frameCount: this.frameFiles.length,
      durationMs: Math.max(0, Date.now() - this.startedAt),
      videoRelPath,
      videoBytes,
      framesRelPaths: [...this.frameFiles],
    });
  }
}
