package provider

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// ProviderKind identifies a supported LLM upstream protocol/vendor.
type ProviderKind string

const (
	ProviderDeepSeek  ProviderKind = "deepseek"
	ProviderOpenAI    ProviderKind = "openai"
	ProviderAnthropic ProviderKind = "anthropic"
	ProviderCustom    ProviderKind = "custom"
)

const (
	DefaultDeepSeekBaseURL  = "https://api.deepseek.com/v1"
	DefaultOpenAIBaseURL    = "https://api.openai.com/v1"
	DefaultAnthropicBaseURL = "https://api.anthropic.com"
)

var (
	// ErrMissingAPIKey indicates no API key was found for the target provider when strict mode is enabled.
	ErrMissingAPIKey = errors.New("provider: missing API key")
	// ErrInvalidConfig indicates a malformed provider configuration or request.
	ErrInvalidConfig = errors.New("provider: invalid configuration")
	// ErrRateLimited indicates the upstream returned HTTP 429 or a rate-limit stream error.
	ErrRateLimited = errors.New("provider: rate limited")
	// ErrContextOverflow indicates the request exceeded the model context window.
	ErrContextOverflow = errors.New("provider: context length exceeded")
)

// IsValid reports whether k is one of the supported provider kinds.
func (k ProviderKind) IsValid() bool {
	switch k {
	case ProviderDeepSeek, ProviderOpenAI, ProviderAnthropic, ProviderCustom:
		return true
	default:
		return false
	}
}

// DefaultBaseURL returns the canonical API base URL for k.
func (k ProviderKind) DefaultBaseURL() string {
	switch k {
	case ProviderDeepSeek:
		return DefaultDeepSeekBaseURL
	case ProviderOpenAI:
		return DefaultOpenAIBaseURL
	case ProviderAnthropic:
		return DefaultAnthropicBaseURL
	default:
		return ""
	}
}

// EnvVarName returns the standard environment variable name holding the API key for k.
func (k ProviderKind) EnvVarName() string {
	switch k {
	case ProviderDeepSeek:
		return "DEEPSEEK_API_KEY"
	case ProviderOpenAI:
		return "OPENAI_API_KEY"
	case ProviderAnthropic:
		return "ANTHROPIC_API_KEY"
	default:
		return "OPENAI_API_KEY"
	}
}

// Role identifies a chat message participant role.
type Role string

const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleTool      Role = "tool"
)

// ToolSpec describes a callable function tool advertised to the model.
type ToolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
}

// ToolCall represents a completed or requested tool invocation emitted by an assistant turn.
type ToolCall struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// ToolResult represents the serialized result of executing a ToolCall.
type ToolResult struct {
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName,omitempty"`
	Output     json.RawMessage `json:"output,omitempty"`
	Error      string          `json:"error,omitempty"`
	IsError    bool            `json:"isError,omitempty"`
}

// Message represents a single normalized conversation turn across providers.
type Message struct {
	Role             Role       `json:"role"`
	Content          string     `json:"content,omitempty"`
	ReasoningContent string     `json:"reasoningContent,omitempty"`
	ToolCalls        []ToolCall `json:"toolCalls,omitempty"`
	ToolCallID       string     `json:"toolCallId,omitempty"`
	ToolName         string     `json:"toolName,omitempty"`
	IsError          bool       `json:"isError,omitempty"`
}

// Usage captures normalized token and cache accounting returned by upstream providers.
type Usage struct {
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CacheReadTokens  int64  `json:"cacheReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	ReasoningTokens  int64  `json:"reasoningTokens"`
	TotalTokens      int64  `json:"totalTokens,omitempty"`
	CostMicros       *int64 `json:"costMicros,omitempty"`
}

// Request represents a normalized streaming chat/messages generation request.
type Request struct {
	Provider        ProviderKind      `json:"provider,omitempty"`
	Model           string            `json:"model"`
	BaseURL         string            `json:"baseUrl,omitempty"`
	APIKey          string            `json:"-"`
	System          string            `json:"system,omitempty"`
	Messages        []Message         `json:"messages"`
	Tools           []ToolSpec        `json:"tools,omitempty"`
	MaxTokens       int               `json:"maxTokens,omitempty"`
	Temperature     *float64          `json:"temperature,omitempty"`
	ReasoningEffort string            `json:"reasoningEffort,omitempty"`
	ThinkingBudget  int               `json:"thinkingBudget,omitempty"`
	ExtraHeaders    map[string]string `json:"extraHeaders,omitempty"`
	Strict          bool              `json:"strict,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}

// ToolCallDelta describes an incremental fragment of a streamed tool call.
type ToolCallDelta struct {
	Index          int    `json:"index"`
	ID             string `json:"id,omitempty"`
	Name           string `json:"name,omitempty"`
	ArgumentsDelta string `json:"argumentsDelta,omitempty"`
}

// StreamDelta represents one streamed chunk emitted to onDelta.
type StreamDelta struct {
	Text          string         `json:"text,omitempty"`
	Reasoning     string         `json:"reasoning,omitempty"`
	ToolCallDelta *ToolCallDelta `json:"toolCallDelta,omitempty"`
}

// DeltaHandler receives incremental streaming deltas while a response is generated.
type DeltaHandler func(delta StreamDelta)

// Response holds the assembled completion output, tool calls, and token usage.
type Response struct {
	Provider     ProviderKind `json:"provider"`
	Model        string       `json:"model"`
	ID           string       `json:"id,omitempty"`
	Text         string       `json:"text,omitempty"`
	Reasoning    string       `json:"reasoning,omitempty"`
	ToolCalls    []ToolCall   `json:"toolCalls,omitempty"`
	FinishReason string       `json:"finishReason,omitempty"`
	Usage        *Usage       `json:"usage,omitempty"`
	Fallback     bool         `json:"fallback,omitempty"`
}

// KeyResolver resolves credentials and optional custom base URLs for a provider.
type KeyResolver func(ctx context.Context, provider ProviderKind) (apiKey, baseURL string, err error)

// ConfigError indicates invalid local provider configuration or missing credentials.
type ConfigError struct {
	Provider ProviderKind
	Field    string
	Message  string
	Err      error
}

func (e *ConfigError) Error() string {
	if e == nil {
		return ""
	}
	if e.Provider != "" && e.Field != "" {
		return fmt.Sprintf("provider(%s) %s: %s", e.Provider, e.Field, e.Message)
	}
	if e.Provider != "" {
		return fmt.Sprintf("provider(%s): %s", e.Provider, e.Message)
	}
	return fmt.Sprintf("provider: %s", e.Message)
}

func (e *ConfigError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// APIError classifies upstream HTTP and SSE error responses.
type APIError struct {
	Provider        ProviderKind
	StatusCode      int
	Code            string
	Type            string
	Message         string
	Retryable       bool
	RateLimited     bool
	ContextOverflow bool
	Body            string
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	msg := e.Message
	if msg == "" {
		msg = e.Body
	}
	if msg == "" {
		msg = "upstream error"
	}
	if e.Code != "" {
		return fmt.Sprintf("provider(%s) status=%d code=%s: %s", e.Provider, e.StatusCode, e.Code, msg)
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("provider(%s) status=%d: %s", e.Provider, e.StatusCode, msg)
	}
	return fmt.Sprintf("provider(%s): %s", e.Provider, msg)
}

func (e *APIError) Unwrap() error {
	if e == nil {
		return nil
	}
	if e.RateLimited {
		return ErrRateLimited
	}
	if e.ContextOverflow {
		return ErrContextOverflow
	}
	return nil
}

func classifyAPIError(prov ProviderKind, statusCode int, code, errType, message, body string) *APIError {
	rateLimited := statusCode == 429 ||
		strings.EqualFold(code, "rate_limit_exceeded") ||
		strings.EqualFold(errType, "rate_limit_error")

	retryable := rateLimited ||
		statusCode == 408 ||
		statusCode == 409 ||
		statusCode == 425 ||
		statusCode >= 500 ||
		strings.EqualFold(errType, "overloaded_error")

	overflow := isContextOverflowError(statusCode, code, errType, message, body)

	return &APIError{
		Provider:        prov,
		StatusCode:      statusCode,
		Code:            code,
		Type:            errType,
		Message:         message,
		Retryable:       retryable,
		RateLimited:     rateLimited,
		ContextOverflow: overflow,
		Body:            body,
	}
}

func isContextOverflowError(statusCode int, code, errType, message, body string) bool {
	if statusCode == 413 {
		return true
	}
	combined := strings.ToLower(code + " " + errType + " " + message + " " + body)
	for _, needle := range []string{
		"context_length_exceeded",
		"maximum context length",
		"prompt is too long",
		"too many tokens",
		"exceeds the context",
		"exceeds context",
		"context window",
		"input is too long",
	} {
		if strings.Contains(combined, needle) {
			return true
		}
	}
	return false
}

// readSSEStream parses Server-Sent Events from r, preserving multi-byte UTF-8 lines
// up to 8 MiB and flushing any trailing event when the stream ends.
func readSSEStream(ctx context.Context, r io.Reader, onEvent func(eventType, data string) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var eventType string
	var dataLines []string

	flush := func() error {
		if len(dataLines) == 0 {
			eventType = ""
			return nil
		}
		ev := eventType
		data := strings.Join(dataLines, "\n")
		eventType = ""
		dataLines = dataLines[:0]
		return onEvent(ev, data)
	}

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := flush(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, val, found := strings.Cut(line, ":")
		if found && strings.HasPrefix(val, " ") {
			val = val[1:]
		}
		switch field {
		case "event":
			eventType = val
		case "data":
			dataLines = append(dataLines, val)
		}
	}

	if err := ctx.Err(); err != nil {
		return err
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return flush()
}

func defaultToolInputSchema(schema map[string]any) map[string]any {
	if len(schema) == 0 {
		return map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}
	}
	return schema
}
