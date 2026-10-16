package ai

// ai, offline: half-written tool arguments, an answer's events in pi's order, the chat request (DeepSeek's
// reasoning sent back, calls without results left out, levels by their provider names), the real HTTP path against
// a local server (tried again on 503, an error as a message, aborted when cancelled), the faux provider, prices.
// Ported from the TypeScript @heybro/ai's ai.test.ts (removed).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func init() { retryBase = 10 * time.Millisecond }

func flash() Model {
	m, _ := GetModel("deepseek", "deepseek-flash")
	return m
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

func jsonEq(t *testing.T, got any, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(marshal(got), &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("got  %s\nwant %s", marshal(got), want)
	}
}

func types(events []AssistantMessageEvent) []string {
	out := []string{}
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

func seq2[T any](items ...T) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		for _, i := range items {
			if !yield(i, nil) {
				return
			}
		}
	}
}

func collect(s iter.Seq[AssistantMessageEvent]) []AssistantMessageEvent {
	var out []AssistantMessageEvent
	for e := range s {
		out = append(out, e)
	}
	return out
}

func collectChan(c <-chan AssistantMessageEvent) []AssistantMessageEvent {
	var out []AssistantMessageEvent
	for e := range c {
		out = append(out, e)
	}
	return out
}

func TestToolArgumentsReadAsTheyGrow(t *testing.T) {
	cases := map[string]string{
		``:                    `{}`,
		`{"path": "src/a`:     `{"path":"src/a"}`,
		`{"a": 1, "b": [1, 2`: `{"a":1,"b":[1,2]}`,
		`{"a": 1, "b"`:        `{"a":1}`,
		`{"a": 1,`:            `{"a":1}`,
		`{"q": "say \"hi`:     `{"q":"say \"hi"}`,
	}
	for in, want := range cases {
		if got := string(ParseStreamingJSON(in)); got != want {
			t.Errorf("ParseStreamingJSON(%q) = %s, want %s", in, got, want)
		}
	}
	eq(t, string(ParseToolArguments(`{"a":1}`)), `{"a":1}`)
	eq(t, string(ParseToolArguments(`not json`)), `{"_unparsed":"not json"}`)
	eq(t, string(ParseToolArguments(``)), `{}`)
}

func chunk(delta ChatDelta, finish string) ChatChunk {
	return ChatChunk{ID: "r1", Choices: []ChatChoice{{Delta: &delta, FinishReason: finish}}}
}

func intp(n int) *int { return &n }

func TestAnAnswersEventsComeInPisOrder(t *testing.T) {
	chunks := []ChatChunk{
		chunk(ChatDelta{ReasoningContent: "先"}, ""),
		chunk(ChatDelta{ReasoningContent: "看看"}, ""),
		chunk(ChatDelta{Content: "好的，"}, ""),
		chunk(ChatDelta{Content: "我读一下。"}, ""),
		chunk(ChatDelta{ToolCalls: []ChatToolCallDelta{{Index: 0, ID: "c1", Function: &ChatToolFunctionDelta{Name: "read", Arguments: `{"path":`}}}}, ""),
		chunk(ChatDelta{ToolCalls: []ChatToolCallDelta{{Index: 0, Function: &ChatToolFunctionDelta{Arguments: ` "a.ts", "limit": null}`}}}}, ""),
		chunk(ChatDelta{ToolCalls: []ChatToolCallDelta{{Index: 1, ID: "c2", Function: &ChatToolFunctionDelta{Name: "ls", Arguments: `{}`}}}}, "tool_calls"),
		{ID: "r1", Choices: []ChatChoice{}, Usage: &ChatUsage{PromptTokens: intp(1000), PromptCacheHitTokens: intp(800), CompletionTokens: intp(50), CompletionTokensDetails: &ChatCompletionDetails{ReasoningTokens: intp(10)}}},
	}
	events := collect(AnswerEvents(flash(), seq2(chunks...)))
	eq(t, types(events), []string{
		"start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end",
		"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_start", "toolcall_delta", "toolcall_end", "toolcall_end", "done",
	})
	// Arguments are read as they come.
	for _, e := range events {
		if e.Type == EventToolCallDelta {
			jsonEq(t, e.Partial.Content[2], `{"type":"toolCall","id":"c1","name":"read","arguments":{}}`)
			break
		}
	}
	done := events[len(events)-1]
	eq(t, done.Reason, StopToolUse)
	eq(t, done.Message.ResponseID, "r1")
	jsonEq(t, done.Message.Content, `[
		{"type":"thinking","thinking":"先看看"},
		{"type":"text","text":"好的，我读一下。"},
		{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"a.ts"}},
		{"type":"toolCall","id":"c2","name":"ls","arguments":{}}
	]`)
	u := done.Message.Usage
	eq(t, []int{u.Input, u.Output, u.CacheRead, u.CacheWrite, *u.Reasoning, u.TotalTokens}, []int{200, 50, 800, 0, 10, 1050})
	if math.Abs(u.Cost.Total-(200*0.14+50*0.28+800*0.028)/1e6) > 1e-12 {
		t.Fatalf("cost %v", u.Cost.Total)
	}
}

func TestAnAnswerCutOffEndsInAnError(t *testing.T) {
	broken := func(yield func(ChatChunk, error) bool) {
		if !yield(chunk(ChatDelta{Content: "一半"}, ""), nil) {
			return
		}
		yield(ChatChunk{}, errors.New("socket hang up"))
	}
	events := collect(AnswerEvents(flash(), broken))
	last := events[len(events)-1]
	eq(t, last.Type, EventError)
	eq(t, last.Error.StopReason, StopError)
	if !strings.Contains(last.Error.ErrorMessage, "socket hang up") {
		t.Fatal(last.Error.ErrorMessage)
	}
	jsonEq(t, last.Error.Content, `[{"type":"text","text":"一半"}]`)

	filtered := collect(AnswerEvents(flash(), seq2(chunk(ChatDelta{Content: "x"}, "content_filter"))))
	eq(t, filtered[len(filtered)-1].Type, EventError)
}

func user(text string) Message { return UserMessage{Content: StringContent(text)} }

func said(content ...Content) Message {
	m := FauxAssistantMessage(content)
	m.API = flash().API
	m.Provider = "deepseek"
	m.Model = flash().ID
	return m
}

func result(id, text string) Message {
	return ToolResultMessage{ToolCallID: id, ToolName: "read", Content: []Content{NewText(text)}}
}

func TestTheChatRequest(t *testing.T) {
	c := Context{
		SystemPrompt: "你是助手",
		Messages: []Message{
			user("读 a.ts"),
			said(FauxThinking("要读文件"), FauxText("我看看"), FauxToolCall("read", `{"path":"a.ts"}`, "c1"), FauxToolCall("read", `{"path":"b.ts"}`, "lost")),
			result("c1", "export {}"),
			result("orphan", "没人要的结果"),
			said(FauxToolCall("read", `{"path":"c.ts"}`, "cut")),
			UserMessage{Content: BlocksContent(NewText("看图"), NewImage("AAA", "image/png"))},
		},
	}
	jsonEq(t, ToChatMessages(flash(), c), `[
		{"role":"system","content":"你是助手"},
		{"role":"user","content":"读 a.ts"},
		{"role":"assistant","content":"我看看","reasoning_content":"要读文件","tool_calls":[{"id":"c1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a.ts\"}"}}]},
		{"role":"tool","tool_call_id":"c1","content":"export {}"},
		{"role":"user","content":"看图\n[图片]"}
	]`)
	// A model that does not want reasoning back does not get it.
	plain := flash()
	plain.Compat = &Compat{}
	eq(t, ToChatMessages(plain, c)[2].ReasoningContent, "")
}

func TestTheRequestBody(t *testing.T) {
	body := RequestBody(flash(), Context{Messages: []Message{user("hi")}, Tools: []Tool{{Name: "ls", Description: "列目录", Parameters: map[string]any{"not": map[string]any{"type": "null"}}}}},
		StreamOptions{Reasoning: ThinkingXHigh, MaxTokens: 100})
	eq(t, body["reasoning_effort"], "max")
	jsonEq(t, body["tools"].([]ChatTool)[0].Function.Parameters, `{"type":"object","properties":{}}`)
	eq(t, body["max_tokens"], 100)
	jsonEq(t, body["stream_options"], `{"include_usage":true}`)
	other := flash()
	other.Reasoning = false
	f := false
	other.Compat = &Compat{MaxTokensField: "max_completion_tokens", SupportsUsageInStreaming: &f}
	plain := RequestBody(other, Context{}, StreamOptions{Reasoning: ThinkingHigh, MaxTokens: 5})
	eq(t, plain["reasoning_effort"], nil)
	eq(t, plain["max_completion_tokens"], 5)
	eq(t, plain["stream_options"], nil)
}

func TestUsageInputIsWhatDidNotComeFromTheCache(t *testing.T) {
	eq(t, UsageOf(&ChatUsage{PromptTokens: intp(10), PromptTokensDetails: &ChatPromptTokensDetails{CachedTokens: intp(4)}, CompletionTokens: intp(3)}),
		RawUsage{Input: 6, Output: 3, CacheRead: 4, CacheWrite: 0})
	eq(t, UsageOf(nil), RawUsage{})
}

func TestModelsPricesAndThinkingLevels(t *testing.T) {
	eq(t, CalculateCost(flash(), RawUsage{Input: 1_000_000, Output: 1_000_000}), UsageCost{Input: 0.14, Output: 0.28, Total: 0.42000000000000004})
	noThinking := flash()
	noThinking.Reasoning = false
	eq(t, GetSupportedThinkingLevels(noThinking), []string{"off"})
	noMax := flash()
	noMax.ThinkingLevelMap = ThinkingLevelMap{}
	for k, v := range flash().ThinkingLevelMap {
		noMax.ThinkingLevelMap[k] = v
	}
	noMax.ThinkingLevelMap[ThinkingMax] = nil
	noMax.ThinkingLevelMap[ThinkingXHigh] = nil
	eq(t, ClampThinkingLevel(noMax, ThinkingMax), ThinkingHigh)
	eq(t, ClampThinkingLevel(flash(), ThinkingLow), ThinkingLow)
}

// endpoint is a chat completions endpoint on this machine: each request answered by reply; what it was asked is kept.
type endpoint struct {
	model  Model
	mu     sync.Mutex
	asked  []*http.Request
	bodies []string
	closed []int
	server *httptest.Server
}

func newEndpoint(reply func(w http.ResponseWriter, r *http.Request, n int)) *endpoint {
	e := &endpoint{}
	e.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		e.mu.Lock()
		e.asked = append(e.asked, r)
		e.bodies = append(e.bodies, string(body))
		n := len(e.asked)
		e.mu.Unlock()
		go func() {
			<-r.Context().Done()
			e.mu.Lock()
			e.closed = append(e.closed, n)
			e.mu.Unlock()
		}()
		reply(w, r, n)
	}))
	e.model = flash()
	e.model.BaseURL = e.server.URL
	return e
}

func sse(w http.ResponseWriter, chunks ...ChatChunk) {
	w.Header().Set("content-type", "text/event-stream")
	w.WriteHeader(200)
	for _, c := range chunks {
		fmt.Fprintf(w, "data: %s\n\n", marshal(c))
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func retries(n int) *int { return &n }

func TestOverHTTPKeySentA503TriedAgain(t *testing.T) {
	server := newEndpoint(func(w http.ResponseWriter, _ *http.Request, n int) {
		if n == 1 {
			w.WriteHeader(503)
			_, _ = w.Write([]byte("busy"))
			return
		}
		sse(w, chunk(ChatDelta{Content: "你好"}, "stop"), ChatChunk{Choices: []ChatChoice{}, Usage: &ChatUsage{PromptTokens: intp(5), CompletionTokens: intp(2)}})
	})
	defer server.server.Close()
	message := Complete(context.Background(), server.model, Context{SystemPrompt: "s", Messages: []Message{user("hi")}}, StreamOptions{APIKey: "sk-test", MaxRetries: retries(1)})
	eq(t, message.StopReason, StopStop)
	jsonEq(t, message.Content, `[{"type":"text","text":"你好"}]`)
	server.mu.Lock()
	defer server.mu.Unlock()
	eq(t, len(server.asked), 2)
	eq(t, server.asked[1].Header.Get("authorization"), "Bearer sk-test")
	var body struct {
		Messages []ChatMessage `json:"messages"`
	}
	_ = json.Unmarshal([]byte(server.bodies[1]), &body)
	eq(t, body.Messages[0].Content, "s")
}

func TestOverHTTPARefusalIsAnErrorMessage(t *testing.T) {
	server := newEndpoint(func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"message":"bad schema"}}`))
	})
	defer server.server.Close()
	message := Complete(context.Background(), server.model, Context{Messages: []Message{user("hi")}}, StreamOptions{APIKey: "k"})
	eq(t, message.StopReason, StopError)
	if !regexp.MustCompile(`400.*bad schema`).MatchString(message.ErrorMessage) {
		t.Fatal(message.ErrorMessage)
	}
	server.mu.Lock()
	eq(t, len(server.asked), 1)
	server.mu.Unlock()
	nobody := server.model
	nobody.Provider = "nobody"
	noKey := Complete(context.Background(), nobody, Context{}, StreamOptions{})
	if !strings.Contains(noKey.ErrorMessage, "没有 nobody 的密钥") {
		t.Fatal(noKey.ErrorMessage)
	}
}

func TestOverHTTPCancellingAbortsTheRequest(t *testing.T) {
	server := newEndpoint(func(w http.ResponseWriter, r *http.Request, _ int) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(200)
		fmt.Fprintf(w, "data: %s\n\n", marshal(chunk(ChatDelta{Content: "一"}, "")))
		w.(http.Flusher).Flush()
		// Never ends by itself.
		<-r.Context().Done()
	})
	defer server.server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := Stream(ctx, server.model, Context{Messages: []Message{user("hi")}}, StreamOptions{APIKey: "k"})
	for e := range events {
		if e.Type == EventTextDelta {
			cancel()
			break
		}
	}
	for range events {
	}
	for i := 0; i < 50; i++ {
		server.mu.Lock()
		n := len(server.closed)
		server.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	eq(t, server.closed, []int{1})
}

func TestFaux(t *testing.T) {
	faux := FauxProvider(FauxProviderOptions{ChunkSize: 2})
	faux.SetResponses(
		FauxAssistantMessage([]Content{FauxThinking("想想"), FauxText("你好呀"), FauxToolCall("ls", `{"path":"."}`, "x")}),
		FauxResponseFactory(func(c Context, _ StreamOptions, _ FauxProviderState, _ Model) AssistantMessage {
			return FauxAssistantMessage(fmt.Sprintf("你说了 %d 句", len(c.Messages)))
		}),
		FauxAssistantMessage("坏了", FauxOptions{StopReason: StopError, ErrorMessage: "服务商挂了"}),
	)
	ctx := WithProviders(context.Background(), faux.Provider)
	model := faux.GetModel()
	events := collectChan(Stream(ctx, model, Context{Messages: []Message{user("hi")}}, StreamOptions{}))
	eq(t, types(events), []string{
		"start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end",
		"toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "done",
	})
	last := events[len(events)-1]
	eq(t, last.Reason, StopToolUse)
	second := Complete(ctx, model, Context{Messages: []Message{user("a"), user("b")}}, StreamOptions{})
	eq(t, second.Content[0].Text, "你说了 2 句")
	eq(t, faux.State().CallCount, 2)
	eq(t, len(faux.State().Contexts[1].Messages), 2)
	failed := Complete(ctx, model, Context{}, StreamOptions{})
	eq(t, failed.StopReason, StopError)
	eq(t, failed.ErrorMessage, "服务商挂了")
	eq(t, Complete(ctx, model, Context{}, StreamOptions{}).ErrorMessage, "faux：剧本里没有下一步了")
	eq(t, faux.GetPendingResponseCount(), 0)
}

func TestAModelWhoseApiNobodyAnswersEndsInAnError(t *testing.T) {
	m := flash()
	m.API = "nobody"
	eq(t, types(collectChan(Stream(context.Background(), m, Context{}, StreamOptions{}))), []string{"error"})
}

func TestMessagesRoundTripAsTS(t *testing.T) {
	line := `{"role":"assistant","content":[{"type":"thinking","thinking":"想"},{"type":"text","text":"好"},{"type":"toolCall","id":"t1","name":"read","arguments":{"path":"a.ts","limit":3}}],"api":"openai-completions","provider":"deepseek","model":"deepseek-flash","usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":5}`
	m, err := DecodeMessage([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	eq(t, Stringify(m), line)
	for _, line := range []string{
		`{"role":"user","content":"hi","timestamp":1}`,
		`{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image","data":"AAA","mimeType":"image/png"}],"timestamp":1}`,
		`{"role":"toolResult","toolCallId":"t1","toolName":"read","content":[{"type":"text","text":"<x> & y"}],"details":{"n":1},"isError":false,"timestamp":2,"durationMs":3}`,
	} {
		m, err := DecodeMessage([]byte(line))
		if err != nil {
			t.Fatal(err)
		}
		eq(t, Stringify(m), line)
	}
}
