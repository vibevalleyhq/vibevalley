import { z } from "zod";

import { jsonOrNone } from "#/base/json.ts";

const decodeAskArgs = jsonOrNone(z.object({ question: z.string() }));

export interface MossToolCall {
  readonly callId: string;
  readonly name: string;
  readonly question: string;
}

const CallSchema = z.object({
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const decodeCallEvent = jsonOrNone(
  z.object({
    action: z.literal("response.function_call_arguments.done"),
    data: CallSchema,
  }),
);
const decodeResponse = jsonOrNone(
  z.object({
    action: z.literal("response.done"),
    data: z.object({
      response: z.object({
        status: z.literal("completed"),
        output: z.array(
          CallSchema.extend({
            type: z.literal("function_call"),
            status: z.literal("completed"),
          }),
        ),
      }),
    }),
  }),
);
const decodeAck = jsonOrNone(
  z.object({
    action: z.literal("conversation.item.created"),
    data: z.object({
      item: z.object({
        type: z.literal("function_call_output"),
        call_id: z.string(),
      }),
    }),
  }),
);

export function extractMossToolCalls(raw: string): readonly MossToolCall[] {
  if (raw.length > 64 * 1024) return [];
  const event = decodeCallEvent(raw);
  const response = event === undefined ? decodeResponse(raw) : undefined;
  const calls = event !== undefined ? [event.data] : (response?.data.response.output ?? []);
  const seen = new Set<string>();
  const output: MossToolCall[] = [];
  for (const call of calls) {
    if (call.name !== "ask_orchestrator" || !call.call_id || call.call_id.length > 256 || seen.has(call.call_id)) continue;
    const args = decodeAskArgs(call.arguments);
    if (args === undefined) continue;
    const question = args.question.trim();
    if (!question || question.length > 16_000) continue;
    seen.add(call.call_id);
    output.push({ callId: call.call_id, name: call.name, question });
  }
  return output;
}

export function extractMossToolAck(raw: string): string | undefined {
  if (raw.length > 64 * 1024) return undefined;
  return decodeAck(raw)?.data.item.call_id || undefined;
}

export const mossOrchestratorTool = {
  type: "function",
  name: "ask_orchestrator",
  description: "Consult the farm's orchestrator whenever the user asks about farm status, issues, helpers, memories, notes, or wants work dispatched.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The user's exact request or question for the orchestrator.",
      },
    },
    required: ["question"],
  },
} as const;

const MossFrame = z.union([
  z.object({
    action: z.literal("session.commentary.append"),
    content: z.string(),
    status: z.literal("completed"),
    event_id: z.string(),
  }),
  z.object({
    action: z.literal("session.update"),
    session: z.object({ persona: z.object({ prompt: z.string() }), instructions: z.string(), tools: z.array(z.unknown()) }),
  }),
  z.object({ action: z.literal("response.create"), response: z.object({ call_ids: z.array(z.string()) }) }),
  z.object({
    action: z.literal("conversation.item.create"),
    item: z.object({ type: z.literal("function_call_output"), call_id: z.string(), output: z.string() }),
  }),
]);

/** A frame the farm says to MOSS Live, as its socket takes it; none for one that does not fit (each is built from strings). */
export const mossFrame = (frame: z.input<typeof MossFrame>): string | undefined => {
  const checked = MossFrame.safeParse(frame);
  return checked.success ? JSON.stringify(checked.data) : undefined;
};
