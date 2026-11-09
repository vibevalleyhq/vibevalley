import { Schema } from "effect";

const MossAskOrchestratorArgsSchema = Schema.fromJsonString(
  Schema.Struct({
    question: Schema.String,
  }),
);
const decodeAskArgs = Schema.decodeUnknownOption(MossAskOrchestratorArgsSchema);

export interface MossToolCall {
  readonly callId: string;
  readonly name: string;
  readonly question: string;
}

const CallSchema = Schema.Struct({
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});
const decodeCallEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.Literal("response.function_call_arguments.done"),
      data: CallSchema,
    }),
  ),
);
const decodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.Literal("response.done"),
      data: Schema.Struct({
        response: Schema.Struct({
          status: Schema.Literal("completed"),
          output: Schema.Array(
            Schema.Struct({
              ...CallSchema.fields,
              type: Schema.Literal("function_call"),
              status: Schema.Literal("completed"),
            }),
          ),
        }),
      }),
    }),
  ),
);
const decodeAck = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      action: Schema.Literal("conversation.item.created"),
      data: Schema.Struct({
        item: Schema.Struct({
          type: Schema.Literal("function_call_output"),
          call_id: Schema.String,
        }),
      }),
    }),
  ),
);

export function extractMossToolCalls(raw: string): readonly MossToolCall[] {
  if (raw.length > 64 * 1024) return [];
  const event = decodeCallEvent(raw);
  const response = event._tag === "None" ? decodeResponse(raw) : undefined;
  const calls = event._tag === "Some" ? [event.value.data] : response?._tag === "Some" ? response.value.data.response.output : [];
  const seen = new Set<string>();
  const output: MossToolCall[] = [];
  for (const call of calls) {
    if (call.name !== "ask_orchestrator" || !call.call_id || call.call_id.length > 256 || seen.has(call.call_id)) continue;
    const args = decodeAskArgs(call.arguments);
    if (args._tag === "None") continue;
    const question = args.value.question.trim();
    if (!question || question.length > 16_000) continue;
    seen.add(call.call_id);
    output.push({ callId: call.call_id, name: call.name, question });
  }
  return output;
}

export function extractMossToolAck(raw: string): string | undefined {
  if (raw.length > 64 * 1024) return undefined;
  const decoded = decodeAck(raw);
  return decoded._tag === "Some" ? decoded.value.data.item.call_id || undefined : undefined;
}

export const mossOrchestratorTool = {
  type: "function",
  name: "ask_orchestrator",
  description: "Consult the farm's orchestrator whenever the owner asks about farm status, issues, helpers, memories, notes, or wants work dispatched.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The owner's exact request or question for the orchestrator.",
      },
    },
    required: ["question"],
  },
} as const;
