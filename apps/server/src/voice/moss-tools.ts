import { Schema } from "effect";

import { decodeMossFrame } from "@vibevalley/provider/moss";

const MossAskOrchestratorArgsSchema = Schema.fromJsonString(
  Schema.Struct({
    question: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
  }),
);
const decodeAskArgs = Schema.decodeUnknownOption(MossAskOrchestratorArgsSchema);

export interface MossToolCall {
  readonly callId: string;
  readonly name: string;
  readonly question: string;
}

export function extractMossToolCall(raw: string): MossToolCall | undefined {
  const decoded = decodeMossFrame(raw);
  if (decoded._tag === "None") return undefined;
  const frame = decoded.value;
  const action = frame.action ?? frame.type ?? "";
  if (action !== "response.function_call_arguments.done" && action !== "tool.call" && action !== "function_call") return undefined;
  const name = frame.data?.name ?? frame.name ?? "";
  if (name !== "ask_orchestrator") return undefined;
  const callId = frame.data?.call_id ?? frame.call_id ?? "";
  const rawArgs = frame.data?.arguments ?? frame.arguments ?? "";
  const parsedArgs = decodeAskArgs(rawArgs);
  const question = parsedArgs._tag === "Some" ? (parsedArgs.value.question ?? parsedArgs.value.text ?? "").trim() : (frame.data?.text ?? rawArgs).trim();
  return question ? { callId, name, question } : undefined;
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
