package ai

// The thinking's signature (or redacted thinking's data) is sent back with it, as the API requires. Turns of the same side are joined, so the
// conversation alternates.

import (
	"context"
	"encoding/json"
	"io"
	"iter"
	"strings"
)

const ANTHROPIC_VERSION = "2023-06-01"

// Only its type's fields are written.
type AnthropicBlock struct {
	Type string
	// text
	Text string
	// image
	Source *AnthropicImageSource
	// thinking
	Thinking  string
	Signature string
	// redacted_thinking
	Data string
	// tool_use
	ID    string
	Name  string
	Input json.RawMessage
	// tool_result
	ToolUseID string
	Content   []AnthropicBlock
	IsError   bool
}

type AnthropicImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

func (b AnthropicBlock) MarshalJSON() ([]byte, error) {
	o := newObject()
	o.set("type", b.Type)
	switch b.Type {
	case "text":
		o.set("text", b.Text)
	case "image":
		o.set("source", b.Source)
	case "thinking":
		o.set("thinking", b.Thinking)
		o.set("signature", b.Signature)
	case "redacted_thinking":
		o.set("data", b.Data)
	case "tool_use":
		o.set("id", b.ID)
		o.set("name", b.Name)
		o.setRaw("input", b.Input)
	case "tool_result":
		o.set("tool_use_id", b.ToolUseID)
		o.set("content", b.Content)
		if b.IsError {
			o.set("is_error", true)
		}
	}
	return o.bytes(), nil
}

type AnthropicMessage struct {
	Role    string           `json:"role"`
	Content []AnthropicBlock `json:"content"`
}

func ToAnthropicMessages(model Model, c Context) (string, []AnthropicMessage) {
	system := []string{c.SystemPrompt}
	out := []AnthropicMessage{}
	answered := answeredCalls(c.Messages)
	called := map[string]bool{}
	images := model.takesImages()
	push := func(role string, blocks []AnthropicBlock) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 && out[n-1].Role == role {
			out[n-1].Content = append(out[n-1].Content, blocks...)
			return
		}
		out = append(out, AnthropicMessage{Role: role, Content: blocks})
	}
	parts := func(content UserContent) []AnthropicBlock {
		if !content.IsBlocks() {
			if content.Text == "" {
				return nil
			}
			return []AnthropicBlock{{Type: "text", Text: content.Text}}
		}
		var blocks []AnthropicBlock
		for _, b := range content.Blocks {
			switch b.Type {
			case TypeText:
				if b.Text != "" {
					blocks = append(blocks, AnthropicBlock{Type: "text", Text: b.Text})
				}
			case TypeImage:
				if images {
					blocks = append(blocks, AnthropicBlock{Type: "image", Source: &AnthropicImageSource{Type: "base64", MediaType: b.MimeType, Data: b.Data}})
				} else {
					blocks = append(blocks, AnthropicBlock{Type: "text", Text: imagePlaceholder})
				}
			}
		}
		return blocks
	}
	for _, m := range c.Messages {
		switch m := m.(type) {
		case SystemMessage:
			if m.Content.IsBlocks() {
				texts := make([]string, 0, len(m.Content.Blocks))
				for _, b := range m.Content.Blocks {
					texts = append(texts, b.Text)
				}
				system = append(system, strings.Join(texts, "\n"))
			} else {
				system = append(system, m.Content.Text)
			}
		case UserMessage:
			push("user", parts(m.Content))
		case AssistantMessage:
			var blocks []AnthropicBlock
			spoken := false
			for _, b := range m.Content {
				switch b.Type {
				case TypeThinking:
					// Thinking goes back only as the API gave it: signed, or redacted.
					if b.Redacted && b.ThinkingSignature != "" {
						blocks = append(blocks, AnthropicBlock{Type: "redacted_thinking", Data: b.ThinkingSignature})
					} else if b.ThinkingSignature != "" {
						blocks = append(blocks, AnthropicBlock{Type: "thinking", Thinking: b.Thinking, Signature: b.ThinkingSignature})
					}
				case TypeText:
					if b.Text != "" {
						blocks = append(blocks, AnthropicBlock{Type: "text", Text: b.Text})
						spoken = true
					}
				case TypeToolCall:
					if answered[b.ID] {
						blocks = append(blocks, AnthropicBlock{Type: "tool_use", ID: b.ID, Name: b.Name, Input: b.Args()})
						called[b.ID] = true
						spoken = true
					}
				}
			}
			if spoken {
				push("assistant", blocks)
			}
		case ToolResultMessage:
			if !called[m.ToolCallID] {
				continue
			}
			content := parts(UserContent{Blocks: m.Content})
			if len(content) == 0 {
				content = []AnthropicBlock{{Type: "text", Text: "（没有内容）"}}
			}
			push("user", []AnthropicBlock{{Type: "tool_result", ToolUseID: m.ToolCallID, Content: content, IsError: m.IsError}})
		}
	}
	var kept []string
	for _, s := range system {
		if s != "" {
			kept = append(kept, s)
		}
	}
	return strings.Join(kept, "\n\n"), out
}

var THINKING_BUDGET = map[string]int{ThinkingMinimal: 1024, ThinkingLow: 2048, ThinkingMedium: 8192, ThinkingHigh: 16384, ThinkingXHigh: 24576, ThinkingMax: 32000}

func effortOf(model Model, level ThinkingLevel) string {
	if v, ok := model.ThinkingLevelMap[level]; ok && v != nil {
		return *v
	}
	switch level {
	case ThinkingMinimal, ThinkingLow:
		return "low"
	case ThinkingMedium:
		return "medium"
	}
	return "high"
}

func AnthropicRequestBody(model Model, c Context, options StreamOptions) map[string]any {
	system, messages := ToAnthropicMessages(model, c)
	compat := model.compat()
	thinking := ""
	if model.Reasoning {
		thinking = options.Reasoning
	}
	budget, hasBudget := 0, false
	if thinking != "" && !compat.ForceAdaptiveThinking {
		budget, hasBudget = THINKING_BUDGET[thinking]
	}
	// Thinking on a budget needs room for the thinking and some words after it: max_tokens grows to fit.
	asked := options.MaxTokens
	if asked == 0 {
		asked = model.MaxTokens
	}
	maxTokens := asked
	if hasBudget {
		maxTokens = max(asked, budget+8192)
	}
	maxTokens = min(model.MaxTokens, maxTokens)
	body := map[string]any{"model": model.ID, "max_tokens": maxTokens, "messages": messages, "stream": true}
	if system != "" {
		body["system"] = system
	}
	if len(c.Tools) > 0 {
		tools := make([]map[string]any, 0, len(c.Tools))
		for _, t := range c.Tools {
			tools = append(tools, map[string]any{"name": t.Name, "description": t.Description, "input_schema": objectSchema(t.Parameters)})
		}
		body["tools"] = tools
		if options.ToolChoice != "" {
			body["tool_choice"] = map[string]any{"type": options.ToolChoice}
		}
	}
	if model.Reasoning {
		switch {
		case thinking == "":
			if v, ok := model.ThinkingLevelMap[ThinkingOff]; !(ok && v == nil) {
				body["thinking"] = map[string]any{"type": "disabled"}
			}
		case compat.ForceAdaptiveThinking:
			body["thinking"] = map[string]any{"type": "adaptive", "display": "summarized"}
			body["output_config"] = map[string]any{"effort": effortOf(model, thinking)}
		default:
			body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": max(1024, min(budget, maxTokens-1024)), "display": "summarized"}
		}
	}
	// Temperature does not go with thinking.
	if options.Temperature != nil && thinking == "" && (compat.SupportsTemperature == nil || *compat.SupportsTemperature) {
		body["temperature"] = *options.Temperature
	}
	return body
}

// content_block_delta's and message_delta's deltas share Delta.
type AnthropicEvent struct {
	Type         string                 `json:"type"`
	Message      *AnthropicEventMessage `json:"message,omitempty"`
	Index        int                    `json:"index"`
	ContentBlock *AnthropicEventBlock   `json:"content_block,omitempty"`
	Delta        *AnthropicEventDelta   `json:"delta,omitempty"`
	Usage        *AnthropicUsage        `json:"usage,omitempty"`
	Error        *AnthropicEventError   `json:"error,omitempty"`
}

type AnthropicEventMessage struct {
	ID    string          `json:"id,omitempty"`
	Usage *AnthropicUsage `json:"usage,omitempty"`
}

type AnthropicEventBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Thinking string `json:"thinking,omitempty"`
	Data     string `json:"data,omitempty"`
	ID       string `json:"id,omitempty"`
	Name     string `json:"name,omitempty"`
}

type AnthropicEventDelta struct {
	Type        string                `json:"type,omitempty"`
	Text        string                `json:"text,omitempty"`
	Thinking    string                `json:"thinking,omitempty"`
	Signature   string                `json:"signature,omitempty"`
	PartialJSON string                `json:"partial_json,omitempty"`
	StopReason  string                `json:"stop_reason,omitempty"`
	StopDetails *AnthropicStopDetails `json:"stop_details,omitempty"`
}

type AnthropicStopDetails struct {
	Explanation string `json:"explanation,omitempty"`
}

type AnthropicEventError struct {
	Type    string `json:"type,omitempty"`
	Message string `json:"message,omitempty"`
}

type AnthropicUsage struct {
	InputTokens              *int `json:"input_tokens,omitempty"`
	OutputTokens             *int `json:"output_tokens,omitempty"`
	CacheReadInputTokens     *int `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens *int `json:"cache_creation_input_tokens,omitempty"`
}

func AnthropicAnswerEvents(model Model, events iter.Seq2[AnthropicEvent, error]) iter.Seq[AssistantMessageEvent] {
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
		usage := RawUsage{}
		take := func(u *AnthropicUsage) {
			if u == nil {
				return
			}
			if u.InputTokens != nil {
				usage.Input = *u.InputTokens
			}
			if u.OutputTokens != nil {
				usage.Output = *u.OutputTokens
			}
			if u.CacheReadInputTokens != nil {
				usage.CacheRead = *u.CacheReadInputTokens
			}
			if u.CacheCreationInputTokens != nil {
				usage.CacheWrite = *u.CacheCreationInputTokens
			}
		}
		stop := ""
		refusal := ""
		for e, err := range events {
			if err != nil {
				if answer == nil {
					answer = NewAnswer(model, "")
				}
				emit(answer.Error(StopError, "回答断了："+err.Error(), usage))
				return
			}
			if answer == nil {
				id := ""
				if e.Type == "message_start" && e.Message != nil {
					id = e.Message.ID
				}
				answer = NewAnswer(model, id)
				if !emit(answer.Start()) {
					return
				}
			}
			ok := true
			switch e.Type {
			case "message_start":
				if e.Message != nil {
					take(e.Message.Usage)
				}
			case "content_block_start":
				block := e.ContentBlock
				if block == nil {
					break
				}
				switch block.Type {
				case "text", "thinking":
					ok = emit(answer.Split())
					if ok && block.Type == "text" && block.Text != "" {
						ok = emit(answer.Text(block.Text))
					}
					if ok && block.Type == "thinking" && block.Thinking != "" {
						ok = emit(answer.Thinking(block.Thinking))
					}
				case "redacted_thinking":
					ok = emit(answer.RedactedThinking(block.Data))
				case "tool_use":
					ok = emit(answer.ToolCall(e.Index, ToolCallPiece{ID: block.ID, Name: block.Name}))
				}
			case "content_block_delta":
				d := e.Delta
				if d == nil {
					break
				}
				switch {
				case d.Type == "text_delta" && d.Text != "":
					ok = emit(answer.Text(d.Text))
				case d.Type == "thinking_delta" && d.Thinking != "":
					ok = emit(answer.Thinking(d.Thinking))
				case d.Type == "signature_delta" && d.Signature != "":
					ok = emit(answer.ThinkingSignature(d.Signature))
				case d.Type == "input_json_delta" && d.PartialJSON != "":
					ok = emit(answer.ToolCall(e.Index, ToolCallPiece{Args: d.PartialJSON}))
				}
			case "message_delta":
				take(e.Usage)
				if e.Delta != nil {
					if e.Delta.StopReason != "" {
						stop = e.Delta.StopReason
					}
					if e.Delta.StopDetails != nil && e.Delta.StopDetails.Explanation != "" {
						refusal = e.Delta.StopDetails.Explanation
					}
				}
			case "error":
				why := "没说为什么"
				if e.Error != nil && e.Error.Message != "" {
					why = e.Error.Message
				} else if e.Error != nil && e.Error.Type != "" {
					why = e.Error.Type
				}
				emit(answer.Error(StopError, model.Provider+" 出错了："+why, usage))
				return
			}
			if !ok {
				return
			}
		}
		if answer == nil {
			answer = NewAnswer(model, "")
		}
		switch stop {
		case "max_tokens":
			emit(answer.Done(StopLength, usage))
		case "tool_use":
			emit(answer.Done(StopToolUse, usage))
		case "refusal":
			if refusal == "" {
				refusal = "模型拒绝回答"
			}
			emit(answer.Error(StopError, refusal, usage))
		case "sensitive":
			emit(answer.Error(StopError, "回答被服务商的内容审核拦下了", usage))
		default:
			emit(answer.Done(StopStop, usage))
		}
	}
}

func streamAnthropicMessages(ctx context.Context, model Model, c Context, options StreamOptions) <-chan AssistantMessageEvent {
	base := strings.TrimSuffix(strings.TrimSuffix(model.BaseURL, "/"), "/v1")
	return streamHTTP(ctx, model, options, httpRequest{
		url: base + "/v1/messages",
		headers: func(key string) map[string]string {
			return map[string]string{"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}
		},
		body: AnthropicRequestBody(model, c, options),
		answer: func(body io.Reader) iter.Seq[AssistantMessageEvent] {
			return AnthropicAnswerEvents(model, sseData[AnthropicEvent](body))
		},
	})
}

var AnthropicMessages = ApiProvider{API: "anthropic-messages", Stream: streamAnthropicMessages}
