import { z } from "zod";

import { bodyChunks, bounded, type ProviderHttp, send } from "../base/http.ts";
import { fromJson } from "../base/json.ts";
import { MossError } from "./error.ts";
import { badKey, rejectedStatuses } from "./response.ts";

const ModelList = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: z.string().min(1),
      object: z.literal("model"),
      created: z.number().int(),
      owned_by: z.string(),
    }),
  ),
});

export const mossModels = (key: string, http: ProviderHttp): Promise<readonly { readonly id: string; readonly owner: string }[]> =>
  bounded(
    15_000,
    http,
    async (signal) => {
      if (badKey(key)) throw new MossError({ reason: "Credentials", outcome: "NotSubmitted" });
      const response = await send(
        http,
        "https://api.mosi.cn/v1/models",
        // Never forward this credential to a redirected endpoint.
        { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "manual" },
        signal,
      );
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(
          // The status is the answer; the body is only dropped.
          () => undefined,
        );
        throw new MossError({
          reason: "HttpStatus",
          status: response.status,
          outcome: rejectedStatuses.includes(response.status) ? "Rejected" : "Unknown",
        });
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of bodyChunks(response, signal)) {
        size += chunk.byteLength;
        if (size > 1 << 20) throw new MossError({ reason: "TooLarge", outcome: "Unknown" });
        chunks.push(chunk);
      }
      const list = fromJson(ModelList, Buffer.concat(chunks).toString("utf8"));
      if (list === undefined) throw new MossError({ reason: "InvalidResponse", outcome: "Unknown" });
      if (list.data.length > 1000) throw new MossError({ reason: "TooLarge", outcome: "Unknown" });
      return list.data.map((model) => ({ id: model.id, owner: model.owned_by }));
    },
    // Transport errors contain authenticated requests; only safe classifications cross this boundary.
    {
      timeout: () => new MossError({ reason: "Timeout", outcome: "Unknown" }),
      network: () => new MossError({ reason: "Network", outcome: "Unknown" }),
    },
  );
