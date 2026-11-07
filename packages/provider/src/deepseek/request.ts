export type DeepSeekContent = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly url: string };

export type DeepSeekMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string | readonly DeepSeekContent[] }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly reasoning?: { readonly signature: string; readonly text: string };
      readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
    };

export interface DeepSeekInput {
  readonly messages: readonly DeepSeekMessage[];
  readonly maxTokens: number;
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
  readonly toolChoice?: "auto" | "none";
  readonly reasoning: boolean;
  readonly thinking?: boolean;
  readonly effort?: string;
}

const reasoningFields = new Set(["reasoning", "reasoning_content", "reasoning_text"]);

export function encodeDeepSeekRequest(model: string, input: DeepSeekInput): Record<string, unknown> {
  return {
    model,
    messages: input.messages.map((message) => {
      switch (message.role) {
        case "system":
          return message;
        case "user":
          return {
            role: message.role,
            content:
              typeof message.content === "string"
                ? message.content
                : message.content.map((part) => (part.type === "text" ? part : { type: "image_url", image_url: { url: part.url } })),
          };
        case "tool":
          return { role: message.role, content: message.content, tool_call_id: message.toolCallId };
        case "assistant": {
          const said: Record<string, unknown> = { role: message.role, content: message.content };
          if (message.reasoning && reasoningFields.has(message.reasoning.signature)) said[message.reasoning.signature] = message.reasoning.text;
          if (message.calls.length > 0)
            said.tool_calls = message.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
          if (input.reasoning && said.reasoning_content === undefined) said.reasoning_content = "";
          return said;
        }
      }
    }),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: input.maxTokens,
    ...(input.tools ? { tools: input.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
    ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
    ...(input.thinking === undefined ? {} : { thinking: { type: input.thinking ? "enabled" : "disabled" } }),
    ...(input.effort ? { reasoning_effort: input.effort } : {}),
  };
}
