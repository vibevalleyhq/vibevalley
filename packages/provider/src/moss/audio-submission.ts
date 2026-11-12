import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { fromJson, int } from "../base/json.ts";
import { AudioId, audioJson, audioRequest, boundedAudio, invalidAudioResponse } from "./audio-response.ts";

const Submission = z.object({
  task_id: AudioId,
  retry_after: z.exactOptional(int()),
});

export interface MossAudioSubmission {
  readonly taskId: string;
  readonly retryAfterSeconds?: number;
}

type Endpoint = "speech/speakers" | "voice/generations" | "transcriptions";

export const submitMossAudioTask = (key: string, endpoint: Endpoint, input: unknown, http: ProviderHttp): Promise<MossAudioSubmission> =>
  boundedAudio(300_000, http, async (signal) => {
    const body = audioJson(input);
    const raw = await audioRequest(key, { method: "POST", url: `https://api.mosi.cn/v1/audio/${endpoint}`, body }, http, signal);
    const result = fromJson(Submission, raw);
    if (result === undefined) throw invalidAudioResponse();
    return {
      taskId: result.task_id,
      ...(result.retry_after !== undefined ? { retryAfterSeconds: result.retry_after } : {}),
    } satisfies MossAudioSubmission;
  });
