package ai

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func claude() Model {
	return Model{
		ID: "claude-test", Name: "Claude（测试）", API: "anthropic-messages", Provider: "anthropic", BaseURL: "https://api.anthropic.com",
		Reasoning: true, Input: []string{"text", "image"}, Cost: ModelCost{Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75},
		ContextWindow: 200_000, MaxTokens: 64_000,
	}
}

func adaptive() Model {
	m := claude()
	m.Compat = &Compat{ForceAdaptiveThinking: true}
	return m
}

func errResult(id, text string) Message {
	return ToolResultMessage{ToolCallID: id, ToolName: "read", Content: []Content{NewText(text)}, IsError: true}
}

func TestTheConversationAsAnthropicWantsIt(t *testing.T) {
	saidMsg := FauxAssistantMessage([]Content{
		{Type: TypeThinking, Thinking: "签过的", ThinkingSignature: "sig1"},
		{Type: TypeThinking, Thinking: "没签的"},
		{Type: TypeThinking, Redacted: true, ThinkingSignature: "secret"},
		FauxText("我看看"),
		FauxToolCall("read", `{"path":"a"}`, "t1"),
		FauxToolCall("read", `{"path":"b"}`, "lost"),
	})
	system, messages := ToAnthropicMessages(claude(), Context{
		SystemPrompt: "你是助手",
		Messages:     []Message{SystemMessage{Content: StringContent("补一句")}, user("读 a"), saidMsg, errResult("t1", "export {}"), result("nobody", "x"), user("然后呢")},
	})
	eq(t, system, "你是助手\n\n补一句")
	jsonEq(t, messages, `[
		{"role":"user","content":[{"type":"text","text":"读 a"}]},
		{"role":"assistant","content":[
			{"type":"thinking","thinking":"签过的","signature":"sig1"},
			{"type":"redacted_thinking","data":"secret"},
			{"type":"text","text":"我看看"},
			{"type":"tool_use","id":"t1","name":"read","input":{"path":"a"}}
		]},
		{"role":"user","content":[
			{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"export {}"}],"is_error":true},
			{"type":"text","text":"然后呢"}
		]}
	]`)
}

func TestThinkingAdaptiveOrOnABudget(t *testing.T) {
	ctx := Context{Messages: []Message{user("hi")}, Tools: []Tool{{Name: "ls", Description: "列目录", Parameters: map[string]any{"not": map[string]any{"type": "null"}}}}}
	a := AnthropicRequestBody(adaptive(), ctx, StreamOptions{Reasoning: ThinkingMedium, ToolChoice: "auto"})
	jsonEq(t, a["thinking"], `{"type":"adaptive","display":"summarized"}`)
	jsonEq(t, a["output_config"], `{"effort":"medium"}`)
	jsonEq(t, a["tool_choice"], `{"type":"auto"}`)
	jsonEq(t, a["tools"].([]map[string]any)[0]["input_schema"], `{"type":"object","properties":{}}`)
	b := AnthropicRequestBody(claude(), ctx, StreamOptions{Reasoning: ThinkingHigh, MaxTokens: 1000})
	jsonEq(t, b["thinking"], `{"type":"enabled","budget_tokens":16384,"display":"summarized"}`)
	eq(t, b["max_tokens"], 16384+8192)
	temp := 0.3
	c := AnthropicRequestBody(claude(), ctx, StreamOptions{Temperature: &temp})
	jsonEq(t, c["thinking"], `{"type":"disabled"}`)
	eq(t, c["temperature"], 0.3)
	eq(t, AnthropicRequestBody(claude(), ctx, StreamOptions{Temperature: &temp, Reasoning: ThinkingLow})["temperature"], nil)
}

func recorded() []AnthropicEvent {
	return []AnthropicEvent{
		{Type: "message_start", Message: &AnthropicEventMessage{ID: "msg_1", Usage: &AnthropicUsage{InputTokens: intp(100), CacheReadInputTokens: intp(900), CacheCreationInputTokens: intp(10), OutputTokens: intp(1)}}},
		{Type: "content_block_start", Index: 0, ContentBlock: &AnthropicEventBlock{Type: "thinking"}},
		{Type: "content_block_delta", Index: 0, Delta: &AnthropicEventDelta{Type: "thinking_delta", Thinking: "先想"}},
		{Type: "content_block_delta", Index: 0, Delta: &AnthropicEventDelta{Type: "signature_delta", Signature: "SIG"}},
		{Type: "content_block_stop", Index: 0},
		{Type: "content_block_start", Index: 1, ContentBlock: &AnthropicEventBlock{Type: "text"}},
		{Type: "content_block_delta", Index: 1, Delta: &AnthropicEventDelta{Type: "text_delta", Text: "我读一下"}},
		{Type: "content_block_stop", Index: 1},
		{Type: "content_block_start", Index: 2, ContentBlock: &AnthropicEventBlock{Type: "tool_use", ID: "toolu_1", Name: "read"}},
		{Type: "content_block_delta", Index: 2, Delta: &AnthropicEventDelta{Type: "input_json_delta", PartialJSON: `{"path":`}},
		{Type: "content_block_delta", Index: 2, Delta: &AnthropicEventDelta{Type: "input_json_delta", PartialJSON: `"a.ts"}`}},
		{Type: "content_block_stop", Index: 2},
		{Type: "message_delta", Delta: &AnthropicEventDelta{StopReason: "tool_use"}, Usage: &AnthropicUsage{OutputTokens: intp(42)}},
		{Type: "message_stop"},
	}
}

func TestARecordedStreamBecomesPisEvents(t *testing.T) {
	events := collect(AnthropicAnswerEvents(claude(), seq2(recorded()...)))
	eq(t, types(events), []string{
		"start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end",
		"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
	})
	done := events[len(events)-1]
	eq(t, done.Reason, StopToolUse)
	jsonEq(t, done.Message.Content, `[
		{"type":"thinking","thinking":"先想","thinkingSignature":"SIG"},
		{"type":"text","text":"我读一下"},
		{"type":"toolCall","id":"toolu_1","name":"read","arguments":{"path":"a.ts"}}
	]`)
	eq(t, done.Message.ResponseID, "msg_1")
	u := done.Message.Usage
	eq(t, []int{u.Input, u.Output, u.CacheRead, u.CacheWrite, u.TotalTokens}, []int{100, 42, 900, 10, 1052})
	_, back := ToAnthropicMessages(claude(), Context{Messages: []Message{user("读"), done.Message, result("toolu_1", "x")}})
	jsonEq(t, back[1].Content[0], `{"type":"thinking","thinking":"先想","signature":"SIG"}`)

	refused := collect(AnthropicAnswerEvents(claude(), seq2(
		AnthropicEvent{Type: "message_start", Message: &AnthropicEventMessage{}},
		AnthropicEvent{Type: "message_delta", Delta: &AnthropicEventDelta{StopReason: "refusal", StopDetails: &AnthropicStopDetails{Explanation: "不能帮这个"}}},
	)))
	last := refused[len(refused)-1]
	eq(t, last.Type, EventError)
	eq(t, last.Error.ErrorMessage, "不能帮这个")
}

func TestAnthropicOverHTTP(t *testing.T) {
	var mu sync.Mutex
	var asked []*http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r)
		n := len(asked)
		mu.Unlock()
		if n == 1 {
			w.WriteHeader(529)
			_, _ = w.Write([]byte("overloaded"))
			return
		}
		w.Header().Set("content-type", "text/event-stream")
		for _, e := range []string{
			`{"type":"message_start","message":{"id":"m","usage":{"input_tokens":5,"output_tokens":1}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
			`{"type":"message_stop"}`,
		} {
			fmt.Fprintf(w, "event: x\ndata: %s\n\n", e)
		}
	}))
	defer server.Close()
	model := claude()
	model.BaseURL = server.URL
	message := Complete(context.Background(), model, Context{Messages: []Message{user("hi")}}, StreamOptions{APIKey: "sk-ant-test", MaxRetries: retries(1)})
	eq(t, message.StopReason, StopStop)
	jsonEq(t, message.Content, `[{"type":"text","text":"你好"}]`)
	mu.Lock()
	defer mu.Unlock()
	eq(t, len(asked), 2)
	eq(t, asked[1].URL.Path, "/v1/messages")
	eq(t, asked[1].Header.Get("x-api-key"), "sk-ant-test")
	eq(t, asked[1].Header.Get("anthropic-version"), "2023-06-01")
}
