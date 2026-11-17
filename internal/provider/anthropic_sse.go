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

const (
	AnthropicVersion          = "2023-06-01"
	defaultAnthropicMaxTokens = 8192
)

// AnthropicOption configures an AnthropicClient.
type AnthropicOption func(*AnthropicClient)

// WithAnthropicHTTPClient overrides the *http.Client used by AnthropicClient.
func WithAnthropicHTTPClient(client *http.Client) AnthropicOption {
	return func(c *AnthropicClient) {
		if client != nil {
			c.httpClient = client
		}
	}
}

// WithAnthropicBaseURL overrides the base URL (defaults to DefaultAnthropicBaseURL).
func WithAnthropicBaseURL(baseURL string) AnthropicOption {
	return func(c *AnthropicClient) {
		c.baseURL = strings.TrimSpace(baseURL)
	}
}

// AnthropicClient streams /v1/messages over SSE for Claude models.
type AnthropicClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewAnthropicClient constructs a pure-Go SSE streaming client for Anthropic's Messages API.
func NewAnthropicClient(opts ...AnthropicOption) *AnthropicClient {
	c := &AnthropicClient{
		httpClient: &http.Client{},
		baseURL:    DefaultAnthropicBaseURL,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(c)
		}
	}
	return c
}

type anthropicAPIRequest struct {
	Model       string                  `json:"model"`
	MaxTokens   int                     `json:"max_tokens"`
	System      string                  `json:"system,omitempty"`
	Messages    []anthropicAPIMessage   `json:"messages"`
	Tools       []anthropicAPITool      `json:"tools,omitempty"`
	Stream      bool                    `json:"stream"`
	Temperature *float64                `json:"temperature,omitempty"`
	Thinking    *anthropicThinkingParam `json:"thinking,omitempty"`
}

type anthropicThinkingParam struct {
	Type         string `json:"type"`
	BudgetTokens int    `json:"budget_tokens"`
}

type anthropicAPIMessage struct {
	Role    string                `json:"role"`
	Content []anthropicBlockParam `json:"content"`
}

type anthropicBlockParam struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   string          `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

type anthropicAPITool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"input_schema"`
}

type anthropicErrorPayload struct {
	Type  string `json:"type"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

type anthropicUsagePayload struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
}

type anthropicSSEEnvelope struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		ID         string                 `json:"id"`
		Model      string                 `json:"model"`
		StopReason string                 `json:"stop_reason"`
		Usage      *anthropicUsagePayload `json:"usage"`
	} `json:"message"`
	ContentBlock *struct {
		Type     string          `json:"type"`
		Text     string          `json:"text"`
		Thinking string          `json:"thinking"`
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
	} `json:"content_block"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		PartialJSON string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage *anthropicUsagePayload `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

type anthropicBlockState struct {
	kind string
	id   string
	name string
	args strings.Builder
	init json.RawMessage
}

// Generate executes a streaming /v1/messages call and invokes onDelta as content or tool fragments arrive.
func (c *AnthropicClient) Generate(ctx context.Context, req Request, onDelta DeltaHandler) (Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	prov := req.Provider
	if prov == "" {
		prov = ProviderAnthropic
	}

	baseURL := strings.TrimSpace(req.BaseURL)
	if baseURL == "" {
		baseURL = c.baseURL
	}
	if baseURL == "" {
		baseURL = DefaultAnthropicBaseURL
	}

	endpoint := buildAnthropicEndpoint(baseURL)
	bodyStruct := buildAnthropicRequest(req)
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
	httpReq.Header.Set("anthropic-version", AnthropicVersion)
	if strings.TrimSpace(req.APIKey) != "" {
		httpReq.Header.Set("x-api-key", strings.TrimSpace(req.APIKey))
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
		return Response{}, parseAnthropicError(prov, resp.StatusCode, rawErr)
	}

	var (
		respID       string
		respModel    = req.Model
		finishReason string
		textBuf      strings.Builder
		reasoningBuf strings.Builder
		blocks       = make(map[int]*anthropicBlockState)
		usage        Usage
		hasUsage     bool
	)

	streamErr := readSSEStream(ctx, resp.Body, func(eventType, data string) error {
		trimmed := strings.TrimSpace(data)
		if trimmed == "" {
			return nil
		}

		var env anthropicSSEEnvelope
		if uErr := json.Unmarshal([]byte(trimmed), &env); uErr != nil {
			return fmt.Errorf("provider(%s): decode SSE event: %w", prov, uErr)
		}

		evKind := env.Type
		if evKind == "" {
			evKind = eventType
		}

		switch evKind {
		case "ping":
			return nil

		case "error":
			if env.Error != nil {
				return classifyAPIError(prov, resp.StatusCode, env.Error.Type, env.Error.Type, env.Error.Message, trimmed)
			}
			return classifyAPIError(prov, resp.StatusCode, "stream_error", "stream_error", trimmed, trimmed)

		case "message_start":
			if env.Message != nil {
				if env.Message.ID != "" {
					respID = env.Message.ID
				}
				if env.Message.Model != "" {
					respModel = env.Message.Model
				}
				if env.Message.StopReason != "" {
					finishReason = env.Message.StopReason
				}
				if env.Message.Usage != nil {
					mergeAnthropicUsage(&usage, env.Message.Usage)
					hasUsage = true
				}
			}

		case "content_block_start":
			if env.ContentBlock != nil {
				blk := &anthropicBlockState{
					kind: env.ContentBlock.Type,
					id:   env.ContentBlock.ID,
					name: env.ContentBlock.Name,
					init: env.ContentBlock.Input,
				}
				blocks[env.Index] = blk
				switch env.ContentBlock.Type {
				case "text":
					if env.ContentBlock.Text != "" {
						textBuf.WriteString(env.ContentBlock.Text)
						if onDelta != nil {
							onDelta(StreamDelta{Text: env.ContentBlock.Text})
						}
					}
				case "thinking":
					if env.ContentBlock.Thinking != "" {
						reasoningBuf.WriteString(env.ContentBlock.Thinking)
						if onDelta != nil {
							onDelta(StreamDelta{Reasoning: env.ContentBlock.Thinking})
						}
					}
				case "tool_use":
					if onDelta != nil {
						onDelta(StreamDelta{
							ToolCallDelta: &ToolCallDelta{
								Index: env.Index,
								ID:    env.ContentBlock.ID,
								Name:  env.ContentBlock.Name,
							},
						})
					}
				}
			}

		case "content_block_delta":
			if env.Delta != nil {
				switch env.Delta.Type {
				case "text_delta":
					if env.Delta.Text != "" {
						textBuf.WriteString(env.Delta.Text)
						if onDelta != nil {
							onDelta(StreamDelta{Text: env.Delta.Text})
						}
					}
				case "thinking_delta":
					if env.Delta.Thinking != "" {
						reasoningBuf.WriteString(env.Delta.Thinking)
						if onDelta != nil {
							onDelta(StreamDelta{Reasoning: env.Delta.Thinking})
						}
					}
				case "input_json_delta":
					blk := blocks[env.Index]
					if blk == nil {
						blk = &anthropicBlockState{kind: "tool_use"}
						blocks[env.Index] = blk
					}
					if env.Delta.PartialJSON != "" {
						blk.args.WriteString(env.Delta.PartialJSON)
						if onDelta != nil {
							onDelta(StreamDelta{
								ToolCallDelta: &ToolCallDelta{
									Index:          env.Index,
									ID:             blk.id,
									Name:           blk.name,
									ArgumentsDelta: env.Delta.PartialJSON,
								},
							})
						}
					}
				}
			}

		case "content_block_stop":
			// Tool blocks finalize on response assembly; stop event acknowledges completion.

		case "message_delta":
			if env.Delta != nil && env.Delta.StopReason != "" {
				finishReason = env.Delta.StopReason
			}
			if env.Usage != nil {
				mergeAnthropicUsage(&usage, env.Usage)
				hasUsage = true
			}

		case "message_stop":
			return errStreamDone
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

	var usagePtr *Usage
	if hasUsage {
		usage.TotalTokens = usage.InputTokens + usage.OutputTokens + usage.CacheReadTokens + usage.CacheWriteTokens
		usagePtr = &usage
	}

	return Response{
		Provider:     prov,
		Model:        respModel,
		ID:           respID,
		Text:         textBuf.String(),
		Reasoning:    reasoningBuf.String(),
		ToolCalls:    finalizeAnthropicToolCalls(blocks),
		FinishReason: finishReason,
		Usage:        usagePtr,
	}, nil
}

func buildAnthropicEndpoint(baseURL string) string {
	trimmed := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(trimmed, "/v1/messages") {
		return trimmed
	}
	if strings.HasSuffix(trimmed, "/v1") {
		return trimmed + "/messages"
	}
	return trimmed + "/v1/messages"
}

func buildAnthropicRequest(req Request) anthropicAPIRequest {
	maxTokens := req.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultAnthropicMaxTokens
	}

	var systemParts []string
	if strings.TrimSpace(req.System) != "" {
		systemParts = append(systemParts, req.System)
	}

	// Leading RoleSystem entries fold into top-level `system` for prompt cache stability;
	// tail RoleSystem entries after conversation turns become user-wrapped updates.
	startedTurns := false
	var apiMsgs []anthropicAPIMessage

	appendToRole := func(role string, blk anthropicBlockParam) {
		if n := len(apiMsgs); n > 0 && apiMsgs[n-1].Role == role {
			apiMsgs[n-1].Content = append(apiMsgs[n-1].Content, blk)
			return
		}
		apiMsgs = append(apiMsgs, anthropicAPIMessage{
			Role:    role,
			Content: []anthropicBlockParam{blk},
		})
	}

	for _, m := range req.Messages {
		switch m.Role {
		case RoleSystem:
			if !startedTurns {
				if strings.TrimSpace(m.Content) != "" {
					systemParts = append(systemParts, m.Content)
				}
			} else if strings.TrimSpace(m.Content) != "" {
				appendToRole("user", anthropicBlockParam{
					Type: "text",
					Text: "<system_update>\n" + m.Content + "\n</system_update>",
				})
			}

		case RoleUser:
			startedTurns = true
			appendToRole("user", anthropicBlockParam{
				Type: "text",
				Text: m.Content,
			})

		case RoleTool:
			startedTurns = true
			appendToRole("user", anthropicBlockParam{
				Type:      "tool_result",
				ToolUseID: m.ToolCallID,
				Content:   m.Content,
				IsError:   m.IsError,
			})

		case RoleAssistant:
			startedTurns = true
			var blocks []anthropicBlockParam
			if m.Content != "" {
				blocks = append(blocks, anthropicBlockParam{
					Type: "text",
					Text: m.Content,
				})
			}
			for _, tc := range m.ToolCalls {
				rawIn := bytes.TrimSpace(tc.Arguments)
				if len(rawIn) == 0 || !json.Valid(rawIn) {
					rawIn = json.RawMessage(`{}`)
				}
				blocks = append(blocks, anthropicBlockParam{
					Type:  "tool_use",
					ID:    tc.ID,
					Name:  tc.Name,
					Input: rawIn,
				})
			}
			if len(blocks) == 0 {
				blocks = append(blocks, anthropicBlockParam{Type: "text", Text: ""})
			}
			if n := len(apiMsgs); n > 0 && apiMsgs[n-1].Role == "assistant" {
				apiMsgs[n-1].Content = append(apiMsgs[n-1].Content, blocks...)
			} else {
				apiMsgs = append(apiMsgs, anthropicAPIMessage{
					Role:    "assistant",
					Content: blocks,
				})
			}
		}
	}

	var tools []anthropicAPITool
	if len(req.Tools) > 0 {
		tools = make([]anthropicAPITool, 0, len(req.Tools))
		for _, t := range req.Tools {
			tools = append(tools, anthropicAPITool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: defaultToolInputSchema(t.InputSchema),
			})
		}
	}

	var thinking *anthropicThinkingParam
	if req.ThinkingBudget > 0 {
		thinking = &anthropicThinkingParam{
			Type:         "enabled",
			BudgetTokens: req.ThinkingBudget,
		}
	}

	return anthropicAPIRequest{
		Model:       req.Model,
		MaxTokens:   maxTokens,
		System:      strings.Join(systemParts, "\n\n"),
		Messages:    apiMsgs,
		Tools:       tools,
		Stream:      true,
		Temperature: req.Temperature,
		Thinking:    thinking,
	}
}

func mergeAnthropicUsage(dst *Usage, src *anthropicUsagePayload) {
	if src == nil {
		return
	}
	if src.InputTokens > 0 {
		dst.InputTokens = src.InputTokens
	}
	if src.OutputTokens > 0 {
		dst.OutputTokens = src.OutputTokens
	}
	if src.CacheReadInputTokens > 0 {
		dst.CacheReadTokens = src.CacheReadInputTokens
	}
	if src.CacheCreationInputTokens > 0 {
		dst.CacheWriteTokens = src.CacheCreationInputTokens
	}
}

func finalizeAnthropicToolCalls(blocks map[int]*anthropicBlockState) []ToolCall {
	if len(blocks) == 0 {
		return nil
	}
	indices := make([]int, 0, len(blocks))
	for idx := range blocks {
		indices = append(indices, idx)
	}
	sort.Ints(indices)

	var out []ToolCall
	for _, idx := range indices {
		blk := blocks[idx]
		if blk.kind != "tool_use" {
			continue
		}
		rawArgs := strings.TrimSpace(blk.args.String())
		if rawArgs == "" {
			initTrimmed := strings.TrimSpace(string(blk.init))
			if initTrimmed != "" && initTrimmed != "null" {
				rawArgs = initTrimmed
			} else {
				rawArgs = "{}"
			}
		}
		out = append(out, ToolCall{
			ID:        blk.id,
			Name:      blk.name,
			Arguments: json.RawMessage(rawArgs),
		})
	}
	return out
}

func parseAnthropicError(prov ProviderKind, status int, raw []byte) error {
	body := strings.TrimSpace(string(raw))
	var payload anthropicErrorPayload
	if json.Unmarshal(raw, &payload) == nil && payload.Error != nil {
		return classifyAPIError(prov, status, payload.Error.Type, payload.Error.Type, payload.Error.Message, body)
	}
	return classifyAPIError(prov, status, "", "", body, body)
}
