export interface DeepSeekUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
  readonly totalTokens: number;
}

export interface DeepSeekChunk {
  readonly id?: string;
  readonly model?: string;
  readonly usage?: DeepSeekUsage;
  readonly finish?: { readonly raw: string; readonly reason: "stop" | "length" | "tool" | "error"; readonly error?: string };
  readonly thinking?: { readonly text: string; readonly signature: string };
  readonly text?: string;
  readonly calls: readonly { readonly index?: number; readonly id?: string; readonly name?: string; readonly arguments: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;

// Optional wire fields remain independent: malformed metadata must not discard valid text or tool deltas.
export function decodeDeepSeekChunk(chunk: unknown): DeepSeekChunk {
  if (!isRecord(chunk)) return { calls: [] };
  const first: unknown = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  const choice = isRecord(first) ? first : undefined;
  const usage = isRecord(chunk.usage) ? chunk.usage : isRecord(choice?.usage) ? choice.usage : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : undefined;
  const signature = reasoningFields.find((field) => typeof delta?.[field] === "string" && delta[field].length > 0);
  const thinking = signature === undefined ? undefined : delta?.[signature];
  return {
    ...(typeof chunk.id === "string" ? { id: chunk.id } : {}),
    ...(typeof chunk.model === "string" && chunk.model.length > 0 ? { model: chunk.model } : {}),
    ...(usage ? { usage: usageOf(usage) } : {}),
    ...(typeof choice?.finish_reason === "string" && choice.finish_reason.length > 0 ? { finish: finishOf(choice.finish_reason) } : {}),
    ...(signature !== undefined && typeof thinking === "string" ? { thinking: { signature, text: thinking } } : {}),
    ...(typeof delta?.content === "string" && delta.content.length > 0 ? { text: delta.content } : {}),
    calls: (Array.isArray(delta?.tool_calls) ? delta.tool_calls.filter(isRecord) : []).map((call) => {
      const fn = isRecord(call.function) ? call.function : undefined;
      return {
        ...(typeof call.index === "number" ? { index: call.index } : {}),
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        ...(typeof fn?.name === "string" ? { name: fn.name } : {}),
        arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
      };
    }),
  };
}

const numberField = (v: unknown) => (typeof v === "number" ? v : undefined);

/** input excludes cached tokens; output already includes reasoning. */
function usageOf(raw: Record<string, unknown>): DeepSeekUsage {
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined;
  const prompt = numberField(raw.prompt_tokens) ?? 0;
  const cacheRead = numberField(promptDetails?.cached_tokens) ?? numberField(raw.prompt_cache_hit_tokens) ?? numberField(raw.cached_tokens) ?? 0;
  const cacheWrite = numberField(promptDetails?.cache_write_tokens) ?? 0;
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  const output = numberField(raw.completion_tokens) ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: numberField(completionDetails?.reasoning_tokens) ?? 0,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
}

function finishOf(raw: string): NonNullable<DeepSeekChunk["finish"]> {
  switch (raw) {
    case "stop":
    case "end":
      return { raw, reason: "stop" };
    case "length":
      return { raw, reason: "length" };
    case "function_call":
    case "tool_calls":
      return { raw, reason: "tool" };
    default:
      return { raw, reason: "error", error: `Provider finish_reason: ${raw}` };
  }
}
