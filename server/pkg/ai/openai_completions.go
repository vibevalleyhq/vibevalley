package ai

// DeepSeek's thinking models want their earlier reasoning sent back as `reasoning_content` (the model's Compat).

import (
	"context"
	"io"
	"iter"
	"strings"
)

type ChatToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"`
	Function ChatToolFunction `json:"function"`
}

type ChatToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type ChatPart struct {
	Type     string        `json:"type"`
	Text     string        `json:"text,omitempty"`
	ImageURL *ChatImageURL `json:"image_url,omitempty"`
}

type ChatImageURL struct {
	URL string `json:"url"`
}

// Content is a string, nil (an assistant's null) or []ChatPart.
type ChatMessage struct {
	Role             string         `json:"role"`
	Content          any            `json:"content"`
	ReasoningContent string         `json:"reasoning_content,omitempty"`
	ToolCalls        []ChatToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string         `json:"tool_call_id,omitempty"`
	Name             string         `json:"name,omitempty"`
}

const imagePlaceholder = "[图片]"

func textOf(content UserContent) string {
	if !content.IsBlocks() {
		return content.Text
	}
	parts := make([]string, 0, len(content.Blocks))
	for _, c := range content.Blocks {
		switch c.Type {
		case TypeText:
			parts = append(parts, c.Text)
		case TypeImage:
			parts = append(parts, imagePlaceholder)
		default:
			parts = append(parts, "")
		}
	}
	return strings.Join(parts, "\n")
}

func answeredCalls(messages []Message) map[string]bool {
	answered := map[string]bool{}
	for _, m := range messages {
		if r, ok := m.(ToolResultMessage); ok {
			answered[r.ToolCallID] = true
		}
	}
	return answered
}

// Tool calls that never got a result and results whose call is gone are left out: the endpoint refuses either.
func ToChatMessages(model Model, c Context) []ChatMessage {
	out := []ChatMessage{}
	if c.SystemPrompt != "" {
		out = append(out, ChatMessage{Role: "system", Content: c.SystemPrompt})
	}
	answered := answeredCalls(c.Messages)
	called := map[string]bool{}
	images := model.takesImages()
	compat := model.compat()
	for _, m := range c.Messages {
		switch m := m.(type) {
		case SystemMessage:
			out = append(out, ChatMessage{Role: "system", Content: textOf(m.Content)})
		case UserMessage:
			hasImage := false
			for _, b := range m.Content.Blocks {
				if b.Type == TypeImage {
					hasImage = true
				}
			}
			if !m.Content.IsBlocks() || !images || !hasImage {
				out = append(out, ChatMessage{Role: "user", Content: textOf(m.Content)})
				continue
			}
			parts := make([]ChatPart, 0, len(m.Content.Blocks))
			for _, b := range m.Content.Blocks {
				if b.Type == TypeText {
					parts = append(parts, ChatPart{Type: "text", Text: b.Text})
				} else {
					parts = append(parts, ChatPart{Type: "image_url", ImageURL: &ChatImageURL{URL: "data:" + b.MimeType + ";base64," + b.Data}})
				}
			}
			out = append(out, ChatMessage{Role: "user", Content: parts})
		case AssistantMessage:
			text := ""
			reasoning := ""
			var calls []ChatToolCall
			for _, b := range m.Content {
				switch b.Type {
				case TypeText:
					text += b.Text
				case TypeThinking:
					reasoning += b.Thinking
				case TypeToolCall:
					if answered[b.ID] {
						calls = append(calls, ChatToolCall{ID: b.ID, Type: "function", Function: ChatToolFunction{Name: b.Name, Arguments: string(b.Args())}})
						called[b.ID] = true
					}
				}
			}
			if text == "" && len(calls) == 0 {
				continue
			}
			msg := ChatMessage{Role: "assistant", ToolCalls: calls}
			if text != "" {
				msg.Content = text
			}
			if reasoning != "" && compat.RequiresReasoningContentOnAssistantMessages {
				msg.ReasoningContent = reasoning
			}
			out = append(out, msg)
		case ToolResultMessage:
			if !called[m.ToolCallID] {
				continue
			}
			content := textOf(UserContent{Blocks: m.Content})
			if content == "" {
				content = "（没有内容）"
			}
			msg := ChatMessage{Role: "tool", ToolCallID: m.ToolCallID, Content: content}
			if compat.RequiresToolResultName {
				msg.Name = m.ToolName
			}
			out = append(out, msg)
		}
	}
	return out
}

func objectSchema(schema map[string]any) map[string]any {
	if schema["type"] == "object" {
		return schema
	}
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

type ChatTool struct {
	Type     string       `json:"type"`
	Function ChatFunction `json:"function"`
}

type ChatFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

func ToChatTools(tools []Tool) []ChatTool {
	out := make([]ChatTool, 0, len(tools))
	for _, t := range tools {
		out = append(out, ChatTool{Type: "function", Function: ChatFunction{Name: t.Name, Description: t.Description, Parameters: objectSchema(t.Parameters)}})
	}
	return out
}

func RequestBody(model Model, c Context, options StreamOptions) map[string]any {
	compat := model.compat()
	effort := ""
	if model.Reasoning && options.Reasoning != "" && (compat.SupportsReasoningEffort == nil || *compat.SupportsReasoningEffort) {
		effort = ProviderThinkingLevel(model, options.Reasoning)
	}
	maxTokensField := compat.MaxTokensField
	if maxTokensField == "" {
		maxTokensField = "max_tokens"
	}
	body := map[string]any{
		"model":    model.ID,
		"messages": ToChatMessages(model, c),
		"stream":   true,
	}
	if compat.SupportsUsageInStreaming == nil || *compat.SupportsUsageInStreaming {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	if len(c.Tools) > 0 {
		body["tools"] = ToChatTools(c.Tools)
		if options.ToolChoice != "" {
			body["tool_choice"] = options.ToolChoice
		}
	}
	if effort != "" {
		body["reasoning_effort"] = effort
	}
	if options.MaxTokens != 0 {
		body[maxTokensField] = options.MaxTokens
	}
	if options.Temperature != nil {
		body["temperature"] = *options.Temperature
	}
	return body
}

type ChatChunk struct {
	ID      string       `json:"id,omitempty"`
	Choices []ChatChoice `json:"choices,omitempty"`
	Usage   *ChatUsage   `json:"usage,omitempty"`
}

type ChatChoice struct {
	Delta        *ChatDelta `json:"delta,omitempty"`
	FinishReason string     `json:"finish_reason,omitempty"`
}

type ChatDelta struct {
	Content          string              `json:"content,omitempty"`
	ReasoningContent string              `json:"reasoning_content,omitempty"`
	ToolCalls        []ChatToolCallDelta `json:"tool_calls,omitempty"`
}

type ChatToolCallDelta struct {
	Index    int                    `json:"index"`
	ID       string                 `json:"id,omitempty"`
	Function *ChatToolFunctionDelta `json:"function,omitempty"`
}

type ChatToolFunctionDelta struct {
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

type ChatUsage struct {
	PromptTokens            *int                     `json:"prompt_tokens,omitempty"`
	CompletionTokens        *int                     `json:"completion_tokens,omitempty"`
	PromptCacheHitTokens    *int                     `json:"prompt_cache_hit_tokens,omitempty"`
	PromptTokensDetails     *ChatPromptTokensDetails `json:"prompt_tokens_details,omitempty"`
	CompletionTokensDetails *ChatCompletionDetails   `json:"completion_tokens_details,omitempty"`
}

type ChatPromptTokensDetails struct {
	CachedTokens *int `json:"cached_tokens,omitempty"`
}

type ChatCompletionDetails struct {
	ReasoningTokens *int `json:"reasoning_tokens,omitempty"`
}

func SSEChunks(body io.Reader) iter.Seq2[ChatChunk, error] { return sseData[ChatChunk](body) }

func intOr(v *int, or int) int {
	if v == nil {
		return or
	}
	return *v
}

// Input without what came from the cache, as pi counts it.
func UsageOf(u *ChatUsage) RawUsage {
	if u == nil {
		return RawUsage{}
	}
	cached := 0
	switch {
	case u.PromptCacheHitTokens != nil:
		cached = *u.PromptCacheHitTokens
	case u.PromptTokensDetails != nil && u.PromptTokensDetails.CachedTokens != nil:
		cached = *u.PromptTokensDetails.CachedTokens
	}
	out := RawUsage{Input: max(0, intOr(u.PromptTokens, 0)-cached), Output: intOr(u.CompletionTokens, 0), CacheRead: cached}
	if u.CompletionTokensDetails != nil && u.CompletionTokensDetails.ReasoningTokens != nil {
		reasoning := *u.CompletionTokensDetails.ReasoningTokens
		out.Reasoning = &reasoning
	}
	return out
}

func AnswerEvents(model Model, chunks iter.Seq2[ChatChunk, error]) iter.Seq[AssistantMessageEvent] {
	return func(yield func(AssistantMessageEvent) bool) {
		emit := func(events []AssistantMessageEvent) bool {
			for _, e := range events {
				if !yield(e) {
					return false
				}
			}
			return true
		}
		var answer *Answer
		finish := ""
		var usage *ChatUsage
		for chunk, err := range chunks {
			if err != nil {
				if answer == nil {
					answer = NewAnswer(model, "")
				}
				emit(answer.Error(StopError, "回答断了："+err.Error(), UsageOf(usage)))
				return
			}
			if answer == nil {
				answer = NewAnswer(model, chunk.ID)
				if !emit(answer.Start()) {
					return
				}
			}
			if chunk.Usage != nil {
				usage = chunk.Usage
			}
			if len(chunk.Choices) == 0 {
				continue
			}
			choice := chunk.Choices[0]
			if d := choice.Delta; d != nil {
				if d.ReasoningContent != "" && !emit(answer.Thinking(d.ReasoningContent)) {
					return
				}
				if d.Content != "" && !emit(answer.Text(d.Content)) {
					return
				}
				for _, tc := range d.ToolCalls {
					piece := ToolCallPiece{ID: tc.ID}
					if tc.Function != nil {
						piece.Name = tc.Function.Name
						piece.Args = tc.Function.Arguments
					}
					if !emit(answer.ToolCall(tc.Index, piece)) {
						return
					}
				}
			}
			if choice.FinishReason != "" {
				finish = choice.FinishReason
			}
		}
		if answer == nil {
			answer = NewAnswer(model, "")
		}
		switch finish {
		case "content_filter":
			emit(answer.Error(StopError, "回答被服务商的内容审核拦下了", UsageOf(usage)))
		case "length":
			emit(answer.Done(StopLength, UsageOf(usage)))
		case "tool_calls", "function_call":
			emit(answer.Done(StopToolUse, UsageOf(usage)))
		default:
			emit(answer.Done(StopStop, UsageOf(usage)))
		}
	}
}

func streamOpenAICompletions(ctx context.Context, model Model, c Context, options StreamOptions) <-chan AssistantMessageEvent {
	return streamHTTP(ctx, model, options, httpRequest{
		url:     strings.TrimSuffix(model.BaseURL, "/") + "/chat/completions",
		headers: func(key string) map[string]string { return map[string]string{"authorization": "Bearer " + key} },
		body:    RequestBody(model, c, options),
		answer:  func(body io.Reader) iter.Seq[AssistantMessageEvent] { return AnswerEvents(model, SSEChunks(body)) },
	})
}

var OpenAICompletions = ApiProvider{API: "openai-completions", Stream: streamOpenAICompletions}
