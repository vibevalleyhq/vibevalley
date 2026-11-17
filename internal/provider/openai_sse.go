package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

var errStreamDone = errors.New("provider: stream done")

// OpenAIOption configures an OpenAIClient.
type OpenAIOption func(*OpenAIClient)

// WithOpenAIHTTPClient overrides the *http.Client used by OpenAIClient.
func WithOpenAIHTTPClient(client *http.Client) OpenAIOption {
	return func(c *OpenAIClient) {
		if client != nil {
			c.httpClient = client
		}
	}
}

// WithOpenAIBaseURL overrides the base URL (defaults to ProviderKind.DefaultBaseURL()).
func WithOpenAIBaseURL(baseURL string) OpenAIOption {
	return func(c *OpenAIClient) {
		c.baseURL = strings.TrimSpace(baseURL)
	}
}

// WithOpenAIProvider sets the provider label emitted on responses and errors (e.g., deepseek, openai, custom).
func WithOpenAIProvider(kind ProviderKind) OpenAIOption {
	return func(c *OpenAIClient) {
		if kind != "" {
			c.provider = kind
		}
	}
}

// OpenAIClient streams Chat Completions over SSE for OpenAI, DeepSeek, and compatible endpoints.
type OpenAIClient struct {
	httpClient *http.Client
	baseURL    string
	provider   ProviderKind
}

// NewOpenAIClient constructs a pure-Go SSE streaming client for OpenAI-compatible endpoints.
func NewOpenAIClient(opts ...OpenAIOption) *OpenAIClient {
	c := &OpenAIClient{
		httpClient: &http.Client{},
		provider:   ProviderOpenAI,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(c)
		}
	}
	return c
}

type openAIAPIRequest struct {
	Model           string            `json:"model"`
	Messages        []openAIMessage   `json:"messages"`
	Tools           []openAIToolSpec  `json:"tools,omitempty"`
	Stream          bool              `json:"stream"`
	StreamOptions   *openAIStreamOpts `json:"stream_options,omitempty"`
	MaxTokens       int               `json:"max_tokens,omitempty"`
	Temperature     *float64          `json:"temperature,omitempty"`
	ReasoningEffort string            `json:"reasoning_effort,omitempty"`
}

type openAIStreamOpts struct {
	IncludeUsage bool `json:"include_usage"`
}

type openAIMessage struct {
	Role             string           `json:"role"`
	Content          string           `json:"content"`
	ReasoningContent string           `json:"reasoning_content,omitempty"`
	ToolCalls        []openAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID       string           `json:"tool_call_id,omitempty"`
}

type openAIToolCall struct {
	ID       string             `json:"id"`
	Type     string             `json:"type"`
	Function openAIToolFunction `json:"function"`
}

type openAIToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type openAIToolSpec struct {
	Type     string                `json:"type"`
	Function openAIToolSpecDetails `json:"function"`
}

type openAIToolSpecDetails struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters"`
}

type openAIErrorPayload struct {
	Error *openAIErrorBody `json:"error"`
}

type openAIErrorBody struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    any    `json:"code"`
}

func (b *openAIErrorBody) codeString() string {
	if b == nil || b.Code == nil {
		return ""
	}
	switch v := b.Code.(type) {
	case string:
		return v
	default:
		return fmt.Sprint(v)
	}
}

type openAIStreamChunk struct {
	ID      string               `json:"id"`
	Model   string               `json:"model"`
	Choices []openAIStreamChoice `json:"choices"`
	Usage   *openAIUsage         `json:"usage"`
	Error   *openAIErrorBody     `json:"error"`
}

type openAIStreamChoice struct {
	Index        int    `json:"index"`
	FinishReason string `json:"finish_reason"`
	Delta        struct {
		Role             string `json:"role"`
		Content          string `json:"content"`
		ReasoningContent string `json:"reasoning_content"`
		Reasoning        string `json:"reasoning"`
		ToolCalls        []struct {
			Index    int    `json:"index"`
			ID       string `json:"id"`
			Type     string `json:"type"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
	} `json:"delta"`
	Message *struct {
		Role             string           `json:"role"`
		Content          string           `json:"content"`
		ReasoningContent string           `json:"reasoning_content"`
		ToolCalls        []openAIToolCall `json:"tool_calls"`
	} `json:"message"`
}

type openAIUsage struct {
	PromptTokens         int64 `json:"prompt_tokens"`
	CompletionTokens     int64 `json:"completion_tokens"`
	TotalTokens          int64 `json:"total_tokens"`
	PromptCacheHitTokens int64 `json:"prompt_cache_hit_tokens"`
	PromptTokensDetails  *struct {
		CachedTokens int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
}

type openAIToolAcc struct {
	id   string
	name strings.Builder
	args strings.Builder
}

// Generate executes a streaming chat completion request and invokes onDelta as fragments arrive.
func (c *OpenAIClient) Generate(ctx context.Context, req Request, onDelta DeltaHandler) (Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	prov := req.Provider
	if prov == "" {
		prov = c.provider
	}
	if prov == "" {
		prov = ProviderOpenAI
	}

	baseURL := strings.TrimSpace(req.BaseURL)
	if baseURL == "" {
		baseURL = c.baseURL
	}
	if baseURL == "" {
		baseURL = prov.DefaultBaseURL()
	}
	if baseURL == "" {
		return Response{}, &ConfigError{
			Provider: prov,
			Field:    "base_url",
			Message:  "base URL is required",
			Err:      ErrInvalidConfig,
		}
	}

	endpoint := buildOpenAIEndpoint(baseURL)
	bodyStruct := buildOpenAIRequest(req)
	bodyBytes, err := json.Marshal(bodyStruct)
	if err != nil {
		return Response{}, fmt.Errorf("provider(%s): marshal request: %w", prov, err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return Response{}, &ConfigError{
			Provider: prov,
			Field:    "base_url",
			Message:  err.Error(),
			Err:      ErrInvalidConfig,
		}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if strings.TrimSpace(req.APIKey) != "" {
		httpReq.Header.Set("Authorization", "Bearer "+strings.TrimSpace(req.APIKey))
	}
	for k, v := range req.ExtraHeaders {
		if strings.TrimSpace(k) != "" {
			httpReq.Header.Set(k, v)
		}
	}

	client := c.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return Response{}, err
	}
	defer resp.Body.Close()

	stopCancel := context.AfterFunc(ctx, func() {
		_ = resp.Body.Close()
	})
	defer stopCancel()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		rawErr, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return Response{}, parseOpenAIError(prov, resp.StatusCode, rawErr)
	}

	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "application/json") && !strings.Contains(ct, "text/event-stream") {
		rawJSON, rErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		if rErr != nil {
			if ctx.Err() != nil {
				return Response{}, ctx.Err()
			}
			return Response{}, rErr
		}
		return decodeOpenAINonStreamResponse(prov, req.Model, rawJSON, onDelta)
	}

	var (
		respID       string
		respModel    = req.Model
		finishReason string
		textBuf      strings.Builder
		reasoningBuf strings.Builder
		toolAccs     = make(map[int]*openAIToolAcc)
		usage        *Usage
	)

	streamErr := readSSEStream(ctx, resp.Body, func(_ string, data string) error {
		trimmed := strings.TrimSpace(data)
		if trimmed == "" {
			return nil
		}
		if trimmed == "[DONE]" {
			return errStreamDone
		}

		var chunk openAIStreamChunk
		if uErr := json.Unmarshal([]byte(trimmed), &chunk); uErr != nil {
			return fmt.Errorf("provider(%s): decode SSE chunk: %w", prov, uErr)
		}
		if chunk.Error != nil {
			return classifyAPIError(prov, resp.StatusCode, chunk.Error.codeString(), chunk.Error.Type, chunk.Error.Message, trimmed)
		}
		if chunk.ID != "" {
			respID = chunk.ID
		}
		if chunk.Model != "" {
			respModel = chunk.Model
		}
		if chunk.Usage != nil {
			usage = normalizeOpenAIUsage(chunk.Usage)
		}

		for _, ch := range chunk.Choices {
			if ch.FinishReason != "" {
				finishReason = ch.FinishReason
			}
			reasoning := ch.Delta.ReasoningContent
			if reasoning == "" {
				reasoning = ch.Delta.Reasoning
			}
			if reasoning != "" {
				reasoningBuf.WriteString(reasoning)
				if onDelta != nil {
					onDelta(StreamDelta{Reasoning: reasoning})
				}
			}
			if ch.Delta.Content != "" {
				textBuf.WriteString(ch.Delta.Content)
				if onDelta != nil {
					onDelta(StreamDelta{Text: ch.Delta.Content})
				}
			}
			for _, tc := range ch.Delta.ToolCalls {
				idx := tc.Index
				if idx < 0 {
					idx = 0
				}
				acc := toolAccs[idx]
				if acc == nil {
					acc = &openAIToolAcc{}
					toolAccs[idx] = acc
				}
				if tc.ID != "" {
					acc.id = tc.ID
				}
				if tc.Function.Name != "" {
					acc.name.WriteString(tc.Function.Name)
				}
				if tc.Function.Arguments != "" {
					acc.args.WriteString(tc.Function.Arguments)
				}
				if onDelta != nil {
					onDelta(StreamDelta{
						ToolCallDelta: &ToolCallDelta{
							Index:          idx,
							ID:             tc.ID,
							Name:           tc.Function.Name,
							ArgumentsDelta: tc.Function.Arguments,
						},
					})
				}
			}
		}
		return nil
	})

	if streamErr != nil && !errors.Is(streamErr, errStreamDone) {
		if ctx.Err() != nil {
			return Response{}, ctx.Err()
		}
		return Response{}, streamErr
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	return Response{
		Provider:     prov,
		Model:        respModel,
		ID:           respID,
		Text:         textBuf.String(),
		Reasoning:    reasoningBuf.String(),
		ToolCalls:    finalizeOpenAIToolCalls(toolAccs),
		FinishReason: finishReason,
		Usage:        usage,
	}, nil
}

func buildOpenAIEndpoint(baseURL string) string {
	trimmed := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(trimmed, "/chat/completions") {
		return trimmed
	}
	return trimmed + "/chat/completions"
}

func buildOpenAIRequest(req Request) openAIAPIRequest {
	msgs := make([]openAIMessage, 0, len(req.Messages)+1)
	if strings.TrimSpace(req.System) != "" {
		msgs = append(msgs, openAIMessage{
			Role:    string(RoleSystem),
			Content: req.System,
		})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case RoleSystem, RoleUser:
			msgs = append(msgs, openAIMessage{
				Role:    string(m.Role),
				Content: m.Content,
			})
		case RoleAssistant:
			om := openAIMessage{
				Role:             string(RoleAssistant),
				Content:          m.Content,
				ReasoningContent: m.ReasoningContent,
			}
			for _, tc := range m.ToolCalls {
				args := strings.TrimSpace(string(tc.Arguments))
				if args == "" {
					args = "{}"
				}
				om.ToolCalls = append(om.ToolCalls, openAIToolCall{
					ID:   tc.ID,
					Type: "function",
					Function: openAIToolFunction{
						Name:      tc.Name,
						Arguments: args,
					},
				})
			}
			msgs = append(msgs, om)
		case RoleTool:
			msgs = append(msgs, openAIMessage{
				Role:       string(RoleTool),
				ToolCallID: m.ToolCallID,
				Content:    m.Content,
			})
		}
	}

	var tools []openAIToolSpec
	if len(req.Tools) > 0 {
		tools = make([]openAIToolSpec, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, openAIToolSpec{
				Type: "function",
				Function: openAIToolSpecDetails{
					Name:        t.Name,
					Description: t.Description,
					Parameters:  defaultToolInputSchema(t.InputSchema),
				},
			})
		}
	}

	return openAIAPIRequest{
		Model:    req.Model,
		Messages: msgs,
		Tools:    tools,
		Stream:   true,
		StreamOptions: &openAIStreamOpts{
			IncludeUsage: true,
		},
		MaxTokens:       req.MaxTokens,
		Temperature:     req.Temperature,
		ReasoningEffort: req.ReasoningEffort,
	}
}

func parseOpenAIError(prov ProviderKind, status int, raw []byte) error {
	body := strings.TrimSpace(string(raw))
	var payload openAIErrorPayload
	if json.Unmarshal(raw, &payload) == nil && payload.Error != nil {
		return classifyAPIError(prov, status, payload.Error.codeString(), payload.Error.Type, payload.Error.Message, body)
	}
	return classifyAPIError(prov, status, "", "", body, body)
}

func normalizeOpenAIUsage(u *openAIUsage) *Usage {
	if u == nil {
		return nil
	}
	var cached int64
	if u.PromptTokensDetails != nil && u.PromptTokensDetails.CachedTokens > 0 {
		cached = u.PromptTokensDetails.CachedTokens
	} else if u.PromptCacheHitTokens > 0 {
		cached = u.PromptCacheHitTokens
	}
	var reasoning int64
	if u.CompletionTokensDetails != nil {
		reasoning = u.CompletionTokensDetails.ReasoningTokens
	}
	return &Usage{
		InputTokens:     u.PromptTokens,
		OutputTokens:    u.CompletionTokens,
		CacheReadTokens: cached,
		ReasoningTokens: reasoning,
		TotalTokens:     u.TotalTokens,
	}
}

func finalizeOpenAIToolCalls(accs map[int]*openAIToolAcc) []ToolCall {
	if len(accs) == 0 {
		return nil
	}
	indices := make([]int, 0, len(accs))
	for idx := range accs {
		indices = append(indices, idx)
	}
	sort.Ints(indices)
	out := make([]ToolCall, 0, len(indices))
	for _, idx := range indices {
		acc := accs[idx]
		rawArgs := strings.TrimSpace(acc.args.String())
		if rawArgs == "" {
			rawArgs = "{}"
		}
		out = append(out, ToolCall{
			ID:        acc.id,
			Name:      acc.name.String(),
			Arguments: json.RawMessage(rawArgs),
		})
	}
	return out
}

func decodeOpenAINonStreamResponse(prov ProviderKind, fallbackModel string, raw []byte, onDelta DeltaHandler) (Response, error) {
	var chunk openAIStreamChunk
	if err := json.Unmarshal(raw, &chunk); err != nil {
		return Response{}, fmt.Errorf("provider(%s): decode response: %w", prov, err)
	}
	if chunk.Error != nil {
		return Response{}, classifyAPIError(prov, 200, chunk.Error.codeString(), chunk.Error.Type, chunk.Error.Message, string(raw))
	}
	model := chunk.Model
	if model == "" {
		model = fallbackModel
	}
	out := Response{
		Provider: prov,
		Model:    model,
		ID:       chunk.ID,
		Usage:    normalizeOpenAIUsage(chunk.Usage),
	}
	if len(chunk.Choices) > 0 {
		ch := chunk.Choices[0]
		out.FinishReason = ch.FinishReason
		if ch.Message != nil {
			out.Text = ch.Message.Content
			out.Reasoning = ch.Message.ReasoningContent
			for _, tc := range ch.Message.ToolCalls {
				args := strings.TrimSpace(tc.Function.Arguments)
				if args == "" {
					args = "{}"
				}
				out.ToolCalls = append(out.ToolCalls, ToolCall{
					ID:        tc.ID,
					Name:      tc.Function.Name,
					Arguments: json.RawMessage(args),
				})
			}
			if onDelta != nil {
				if out.Reasoning != "" {
					onDelta(StreamDelta{Reasoning: out.Reasoning})
				}
				if out.Text != "" {
					onDelta(StreamDelta{Text: out.Text})
				}
			}
		}
	}
	return out, nil
}
