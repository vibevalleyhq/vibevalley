package provider_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/provider"
)

func TestOpenAISSEChunkedUTF8AndReasoningAndTools(t *testing.T) {
	t.Parallel()

	var capturedAuth string
	var capturedBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		capturedAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)

		// Chunk 1: reasoning_content for DeepSeek reasoner.
		_, _ = fmt.Fprint(w, "data: {\"id\":\"cmpl-1\",\"model\":\"deepseek-reasoner\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"先检查\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = fmt.Fprint(w, "data: {\"id\":\"cmpl-1\",\"model\":\"deepseek-reasoner\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"工单状态\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}

		// Split a multi-byte UTF-8 Chinese payload across raw TCP writes to verify line buffering.
		splitLine := "data: {\"id\":\"cmpl-1\",\"model\":\"deepseek-reasoner\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好，码农场！\"}}]}\n\n"
		mid := strings.Index(splitLine, "码") + 1 // cut inside 3-byte UTF-8 rune
		_, _ = w.Write([]byte(splitLine[:mid]))
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write([]byte(splitLine[mid:]))
		if flusher != nil {
			flusher.Flush()
		}

		// Incremental parallel tool calls across chunks.
		chunks := []string{
			`{"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"issue_","arguments":""}}]}}]}`,
			`{"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"list","arguments":"{\"stat"}}]}}]}`,
			`{"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"repo_list","arguments":"{}"}}]}}]}`,
			`{"id":"cmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"us\":\"in_progress\"}"}}]},"finish_reason":"tool_calls"}]}`,
			`{"id":"cmpl-1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":35,"total_tokens":155,"prompt_cache_hit_tokens":80,"completion_tokens_details":{"reasoning_tokens":12}}}`,
		}
		for _, ch := range chunks {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", ch)
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()

	client := provider.NewOpenAIClient(
		provider.WithOpenAIProvider(provider.ProviderDeepSeek),
		provider.WithOpenAIBaseURL(srv.URL+"/v1"),
	)

	var textDeltas []string
	var reasoningDeltas []string
	var toolDeltas int

	resp, err := client.Generate(context.Background(), provider.Request{
		Model:  "deepseek-reasoner",
		APIKey: "ds-test-key",
		System: "你是助手",
		Messages: []provider.Message{
			{Role: provider.RoleUser, Content: "看看进展"},
		},
		Tools: []provider.ToolSpec{
			{Name: "issue_list", Description: "list issues"},
			{Name: "repo_list", Description: "list repos"},
		},
	}, func(d provider.StreamDelta) {
		if d.Text != "" {
			textDeltas = append(textDeltas, d.Text)
		}
		if d.Reasoning != "" {
			reasoningDeltas = append(reasoningDeltas, d.Reasoning)
		}
		if d.ToolCallDelta != nil {
			toolDeltas++
		}
	})
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	if capturedAuth != "Bearer ds-test-key" {
		t.Fatalf("Authorization = %q", capturedAuth)
	}
	if streamFlag, _ := capturedBody["stream"].(bool); !streamFlag {
		t.Fatalf("expected stream=true in body: %+v", capturedBody)
	}
	streamOpts, _ := capturedBody["stream_options"].(map[string]any)
	if inc, _ := streamOpts["include_usage"].(bool); !inc {
		t.Fatalf("expected stream_options.include_usage=true, got %+v", capturedBody["stream_options"])
	}

	if resp.Text != "你好，码农场！" {
		t.Fatalf("Text = %q, want %q", resp.Text, "你好，码农场！")
	}
	if strings.Join(textDeltas, "") != "你好，码农场！" {
		t.Fatalf("textDeltas = %v", textDeltas)
	}
	if resp.Reasoning != "先检查工单状态" || strings.Join(reasoningDeltas, "") != "先检查工单状态" {
		t.Fatalf("Reasoning = %q, deltas = %v", resp.Reasoning, reasoningDeltas)
	}
	if resp.FinishReason != "tool_calls" {
		t.Fatalf("FinishReason = %q", resp.FinishReason)
	}
	if toolDeltas != 4 {
		t.Fatalf("toolDeltas = %d, want 4", toolDeltas)
	}
	if len(resp.ToolCalls) != 2 {
		t.Fatalf("ToolCalls count = %d, want 2: %+v", len(resp.ToolCalls), resp.ToolCalls)
	}
	if resp.ToolCalls[0].ID != "call_1" || resp.ToolCalls[0].Name != "issue_list" || string(resp.ToolCalls[0].Arguments) != `{"status":"in_progress"}` {
		t.Fatalf("unexpected ToolCalls[0]: %+v args=%s", resp.ToolCalls[0], string(resp.ToolCalls[0].Arguments))
	}
	if resp.ToolCalls[1].ID != "call_2" || resp.ToolCalls[1].Name != "repo_list" || string(resp.ToolCalls[1].Arguments) != `{}` {
		t.Fatalf("unexpected ToolCalls[1]: %+v args=%s", resp.ToolCalls[1], string(resp.ToolCalls[1].Arguments))
	}
	if resp.Usage == nil || resp.Usage.InputTokens != 120 || resp.Usage.OutputTokens != 35 || resp.Usage.CacheReadTokens != 80 || resp.Usage.ReasoningTokens != 12 {
		t.Fatalf("unexpected usage: %+v", resp.Usage)
	}
}

func TestAnthropicSSEStreamingAndCacheTokens(t *testing.T) {
	t.Parallel()

	var gotVersion, gotKey string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		gotVersion = r.Header.Get("anthropic-version")
		gotKey = r.Header.Get("x-api-key")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)

		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)

		events := []struct {
			event string
			data  string
		}{
			{"message_start", `{"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-5","usage":{"input_tokens":42,"cache_creation_input_tokens":100,"cache_read_input_tokens":250,"output_tokens":1}}}`},
			{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
			{"ping", `{"type":"ping"}`},
			{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"收到，"}}`},
			{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"正在查询。"}}`},
			{"content_block_stop", `{"type":"content_block_stop","index":0}`},
			{"content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"pkm_search","input":{}}}`},
			{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"text\":"}}`},
			{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"架构设计\"}"}}`},
			{"content_block_stop", `{"type":"content_block_stop","index":1}`},
			{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":64}}`},
			{"message_stop", `{"type":"message_stop"}`},
		}
		for _, ev := range events {
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.event, ev.data)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	client := provider.NewAnthropicClient(provider.WithAnthropicBaseURL(srv.URL))
	var deltas []string
	resp, err := client.Generate(context.Background(), provider.Request{
		Model:  "claude-sonnet-4-5",
		APIKey: "ant-key-123",
		System: "系统提示",
		Messages: []provider.Message{
			{Role: provider.RoleUser, Content: "帮我查一下"},
			{Role: provider.RoleAssistant, Content: "好", ToolCalls: []provider.ToolCall{{ID: "t1", Name: "repo_list", Arguments: json.RawMessage(`{}`)}}},
			{Role: provider.RoleTool, ToolCallID: "t1", Content: `{"repos":[]}`},
			{Role: provider.RoleUser, Content: "继续"},
		},
		Tools: []provider.ToolSpec{
			{Name: "pkm_search", Description: "search notes", InputSchema: map[string]any{"type": "object"}},
		},
	}, func(d provider.StreamDelta) {
		if d.Text != "" {
			deltas = append(deltas, d.Text)
		}
	})
	if err != nil {
		t.Fatalf("Anthropic Generate failed: %v", err)
	}

	if gotVersion != provider.AnthropicVersion || gotKey != "ant-key-123" {
		t.Fatalf("unexpected headers: version=%q key=%q", gotVersion, gotKey)
	}
	if streamFlag, _ := gotBody["stream"].(bool); !streamFlag {
		t.Fatalf("expected stream=true in Anthropic body")
	}
	// Verify consecutive tool+user messages were coalesced into a single user turn.
	msgs, _ := gotBody["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("expected 3 coalesced Anthropic messages (user, assistant, user), got %d: %+v", len(msgs), msgs)
	}

	if resp.ID != "msg_01" || resp.FinishReason != "tool_use" {
		t.Fatalf("unexpected resp metadata: %+v", resp)
	}
	if resp.Text != "收到，正在查询。" || strings.Join(deltas, "") != "收到，正在查询。" {
		t.Fatalf("unexpected Text=%q deltas=%v", resp.Text, deltas)
	}
	if len(resp.ToolCalls) != 1 || resp.ToolCalls[0].ID != "toolu_01" || resp.ToolCalls[0].Name != "pkm_search" || string(resp.ToolCalls[0].Arguments) != `{"text":"架构设计"}` {
		t.Fatalf("unexpected ToolCalls: %+v", resp.ToolCalls)
	}
	if resp.Usage == nil ||
		resp.Usage.InputTokens != 42 ||
		resp.Usage.OutputTokens != 64 ||
		resp.Usage.CacheReadTokens != 250 ||
		resp.Usage.CacheWriteTokens != 100 {
		t.Fatalf("unexpected Anthropic usage: %+v", resp.Usage)
	}
}

func TestProviderErrorClassification(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name         string
		status       int
		body         string
		wantRetry    bool
		wantRateLim  bool
		wantOverflow bool
	}{
		{
			name:        "429 rate limited",
			status:      http.StatusTooManyRequests,
			body:        `{"error":{"message":"rate limit reached","type":"rate_limit_error","code":"rate_limit_exceeded"}}`,
			wantRetry:   true,
			wantRateLim: true,
		},
		{
			name:      "500 server error",
			status:    http.StatusInternalServerError,
			body:      `{"error":{"message":"internal error","type":"server_error"}}`,
			wantRetry: true,
		},
		{
			name:         "400 context overflow",
			status:       http.StatusBadRequest,
			body:         `{"error":{"message":"This model's maximum context length is 128000 tokens","code":"context_length_exceeded"}}`,
			wantOverflow: true,
		},
		{
			name:   "401 unauthorized non-retryable",
			status: http.StatusUnauthorized,
			body:   `{"error":{"message":"invalid api key","code":"invalid_api_key"}}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			client := provider.NewOpenAIClient(provider.WithOpenAIBaseURL(srv.URL + "/v1"))
			_, err := client.Generate(context.Background(), provider.Request{
				Model:  "gpt-4o",
				APIKey: "test-key",
				Messages: []provider.Message{
					{Role: provider.RoleUser, Content: "hi"},
				},
			}, nil)
			if err == nil {
				t.Fatalf("expected error")
			}
			var apiErr *provider.APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("expected *provider.APIError, got %T: %v", err, err)
			}
			if apiErr.StatusCode != tc.status {
				t.Fatalf("StatusCode = %d, want %d", apiErr.StatusCode, tc.status)
			}
			if apiErr.Retryable != tc.wantRetry {
				t.Fatalf("Retryable = %v, want %v", apiErr.Retryable, tc.wantRetry)
			}
			if apiErr.RateLimited != tc.wantRateLim {
				t.Fatalf("RateLimited = %v, want %v", apiErr.RateLimited, tc.wantRateLim)
			}
			if apiErr.ContextOverflow != tc.wantOverflow {
				t.Fatalf("ContextOverflow = %v, want %v", apiErr.ContextOverflow, tc.wantOverflow)
			}
			if tc.wantRateLim && !errors.Is(err, provider.ErrRateLimited) {
				t.Fatalf("expected errors.Is(err, ErrRateLimited)")
			}
			if tc.wantOverflow && !errors.Is(err, provider.ErrContextOverflow) {
				t.Fatalf("expected errors.Is(err, ErrContextOverflow)")
			}
		})
	}
}

func TestStreamContextCancellation(t *testing.T) {
	t.Parallel()

	firstSent := make(chan struct{})
	release := make(chan struct{})
	defer close(release)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"开始\"}}]}\n\n")
		if flusher != nil {
			flusher.Flush()
		}
		close(firstSent)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client := provider.NewOpenAIClient(provider.WithOpenAIBaseURL(srv.URL + "/v1"))
	errCh := make(chan error, 1)
	go func() {
		_, err := client.Generate(ctx, provider.Request{
			Model:  "deepseek-chat",
			APIKey: "k",
			Messages: []provider.Message{
				{Role: provider.RoleUser, Content: "hello"},
			},
		}, nil)
		errCh <- err
	}()

	<-firstSent
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for cancellation")
	}
}

func TestRouterModelPrefixAndNoKeyFallback(t *testing.T) {
	t.Parallel()

	var networkHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		networkHits.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		switch r.URL.Path {
		case "/v1/messages":
			_, _ = fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":5,\"output_tokens\":1}}}\n\n")
			_, _ = fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\" }}\n\n")
			_, _ = fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"from-anthropic\"}}\n\n")
			_, _ = fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\n")
			_, _ = fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		case "/v1/chat/completions":
			var body map[string]any
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			model, _ := body["model"].(string)
			_, _ = fmt.Fprintf(w, "data: {\"id\":\"o1\",\"model\":%q,\"choices\":[{\"index\":0,\"delta\":{\"content\":%q},\"finish_reason\":\"stop\"}]}\n\n", model, "from-"+model)
			_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer srv.Close()

	// 1. No-key fallback must NOT make any external network calls.
	noKeyRouter := provider.NewRouter(provider.RouterConfig{
		HTTPClient: srv.Client(),
		KeyResolver: func(_ context.Context, _ provider.ProviderKind) (string, string, error) {
			return "", srv.URL + "/v1", nil
		},
	})
	var fallbackStreamed string
	fbResp, err := noKeyRouter.Generate(context.Background(), provider.Request{
		Model:    "deepseek-chat",
		Messages: []provider.Message{{Role: provider.RoleUser, Content: "你好"}},
	}, func(d provider.StreamDelta) {
		fallbackStreamed += d.Text
	})
	if err != nil {
		t.Fatalf("non-strict no-key fallback failed: %v", err)
	}
	if !fbResp.Fallback || fbResp.Provider != provider.ProviderDeepSeek || fbResp.Text == "" || fallbackStreamed == "" {
		t.Fatalf("unexpected fallback response: %+v streamed=%q", fbResp, fallbackStreamed)
	}
	if networkHits.Load() != 0 {
		t.Fatalf("expected 0 network calls on no-key fallback, got %d", networkHits.Load())
	}

	// Strict mode returns ErrMissingAPIKey with 0 network calls.
	_, err = noKeyRouter.Generate(context.Background(), provider.Request{
		Model:    "claude-sonnet-4-5",
		Strict:   true,
		Messages: []provider.Message{{Role: provider.RoleUser, Content: "你好"}},
	}, nil)
	if !errors.Is(err, provider.ErrMissingAPIKey) {
		t.Fatalf("expected ErrMissingAPIKey in strict mode, got %v", err)
	}
	if networkHits.Load() != 0 {
		t.Fatalf("expected 0 network calls in strict missing-key mode, got %d", networkHits.Load())
	}

	// 2. Prefix routing across all supported families.
	router := provider.NewRouter(provider.RouterConfig{
		HTTPClient: srv.Client(),
		KeyResolver: func(_ context.Context, p provider.ProviderKind) (string, string, error) {
			if p == provider.ProviderAnthropic {
				return "key-" + string(p), srv.URL, nil
			}
			return "key-" + string(p), srv.URL + "/v1", nil
		},
	})

	routeCases := []struct {
		model    string
		explicit provider.ProviderKind
		wantProv provider.ProviderKind
		wantText string
	}{
		{model: "claude-sonnet-4-5", wantProv: provider.ProviderAnthropic, wantText: "from-anthropic"},
		{model: "deepseek-chat", wantProv: provider.ProviderDeepSeek, wantText: "from-deepseek-chat"},
		{model: "gpt-4o", wantProv: provider.ProviderOpenAI, wantText: "from-gpt-4o"},
		{model: "o1-preview", wantProv: provider.ProviderOpenAI, wantText: "from-o1-preview"},
		{model: "o3-mini", wantProv: provider.ProviderOpenAI, wantText: "from-o3-mini"},
		{model: "o4-mini", wantProv: provider.ProviderOpenAI, wantText: "from-o4-mini"},
		{model: "my-local-model", explicit: provider.ProviderCustom, wantProv: provider.ProviderCustom, wantText: "from-my-local-model"},
	}
	for _, rc := range routeCases {
		resp, err := router.Generate(context.Background(), provider.Request{
			Provider: rc.explicit,
			Model:    rc.model,
			Messages: []provider.Message{{Role: provider.RoleUser, Content: "ping"}},
		}, nil)
		if err != nil {
			t.Fatalf("model %q failed: %v", rc.model, err)
		}
		if resp.Provider != rc.wantProv {
			t.Fatalf("model %q routed to %q, want %q", rc.model, resp.Provider, rc.wantProv)
		}
		if resp.Text != rc.wantText {
			t.Fatalf("model %q text = %q, want %q", rc.model, resp.Text, rc.wantText)
		}
	}
}
