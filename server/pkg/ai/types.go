// Package ai is messages, models and streaming calls to them, shaped and named as pi-ai 1.1.0 names them (role
// `toolResult`, content `toolCall`, events `text_delta`, stop reason `toolUse`...), so a pi transcript and ours read
// the same. Ported from the TypeScript @heybro/ai (removed): the JSON of every message is the TS one, field for field, so a
// conversation saved by either reads back in the other.
package ai

import (
	"encoding/json"
	"fmt"
)

// ── Content ─────────────────────────────────────────────────────────────

// Content types.
const (
	TypeText     = "text"
	TypeThinking = "thinking"
	TypeImage    = "image"
	TypeToolCall = "toolCall"
)

// Content is one block of a message: TS's TextContent | ThinkingContent | ImageContent | ToolCall, flat, told
// apart by Type. Only the fields of its type are written to JSON.
type Content struct {
	Type string

	// text
	Text          string
	TextSignature string

	// thinking
	Thinking          string
	ThinkingSignature string
	Redacted          bool

	// image: Data is base64.
	Data     string
	MimeType string

	// toolCall: Arguments is always a JSON object ({} when there are none), its keys in the order the model gave them.
	ID        string
	Name      string
	Arguments json.RawMessage
}

// NewText is a text block.
func NewText(text string) Content { return Content{Type: TypeText, Text: text} }

// NewThinking is a thinking block.
func NewThinking(thinking string) Content { return Content{Type: TypeThinking, Thinking: thinking} }

// NewImage is an image block (data in base64).
func NewImage(data, mimeType string) Content {
	return Content{Type: TypeImage, Data: data, MimeType: mimeType}
}

// NewToolCall is a tool call block; arguments is a JSON object.
func NewToolCall(id, name string, arguments json.RawMessage) Content {
	return Content{Type: TypeToolCall, ID: id, Name: name, Arguments: arguments}
}

// Args is the tool call's arguments, {} when there are none.
func (c Content) Args() json.RawMessage {
	if len(c.Arguments) == 0 {
		return json.RawMessage("{}")
	}
	return c.Arguments
}

func (c Content) MarshalJSON() ([]byte, error) {
	o := newObject()
	o.set("type", c.Type)
	switch c.Type {
	case TypeText:
		o.set("text", c.Text)
		if c.TextSignature != "" {
			o.set("textSignature", c.TextSignature)
		}
	case TypeThinking:
		o.set("thinking", c.Thinking)
		if c.ThinkingSignature != "" {
			o.set("thinkingSignature", c.ThinkingSignature)
		}
		if c.Redacted {
			o.set("redacted", true)
		}
	case TypeImage:
		o.set("data", c.Data)
		o.set("mimeType", c.MimeType)
	case TypeToolCall:
		o.set("id", c.ID)
		o.set("name", c.Name)
		o.setRaw("arguments", c.Args())
	}
	return o.bytes(), nil
}

func (c *Content) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type              string          `json:"type"`
		Text              string          `json:"text"`
		TextSignature     string          `json:"textSignature"`
		Thinking          string          `json:"thinking"`
		ThinkingSignature string          `json:"thinkingSignature"`
		Redacted          bool            `json:"redacted"`
		Data              string          `json:"data"`
		MimeType          string          `json:"mimeType"`
		ID                string          `json:"id"`
		Name              string          `json:"name"`
		Arguments         json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*c = Content{
		Type: wire.Type, Text: wire.Text, TextSignature: wire.TextSignature,
		Thinking: wire.Thinking, ThinkingSignature: wire.ThinkingSignature, Redacted: wire.Redacted,
		Data: wire.Data, MimeType: wire.MimeType, ID: wire.ID, Name: wire.Name,
	}
	if wire.Type == TypeToolCall {
		args := compactObject(wire.Arguments)
		if args == nil {
			args = json.RawMessage("{}")
		}
		c.Arguments = args
	}
	return nil
}

// UserContent is a system, user or custom message's content: a plain string (TS `string`), or blocks (text and
// images). Blocks nil means the string form.
type UserContent struct {
	Text   string
	Blocks []Content
}

// StringContent is content given as a string.
func StringContent(text string) UserContent { return UserContent{Text: text} }

// BlocksContent is content given as blocks.
func BlocksContent(blocks ...Content) UserContent {
	if blocks == nil {
		blocks = []Content{}
	}
	return UserContent{Blocks: blocks}
}

// IsBlocks reports the block form.
func (c UserContent) IsBlocks() bool { return c.Blocks != nil }

func (c UserContent) MarshalJSON() ([]byte, error) {
	if c.Blocks != nil {
		return marshal(c.Blocks), nil
	}
	return marshal(c.Text), nil
}

func (c *UserContent) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*c = UserContent{Text: text}
		return nil
	}
	var blocks []Content
	if err := json.Unmarshal(data, &blocks); err != nil {
		return err
	}
	if blocks == nil {
		blocks = []Content{}
	}
	*c = UserContent{Blocks: blocks}
	return nil
}

// ── Usage and why it stopped ────────────────────────────────────────────

// StopReason is why an answer ended.
type StopReason string

const (
	StopStop    StopReason = "stop"
	StopLength  StopReason = "length"
	StopToolUse StopReason = "toolUse"
	StopError   StopReason = "error"
	StopAborted StopReason = "aborted"
)

// UsageCost is dollars, per part and in all.
type UsageCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

// Usage is the tokens an answer took.
type Usage struct {
	// Input tokens not read from the cache.
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	// Of Output, how many were thinking (nil: not reported).
	Reasoning   *int      `json:"reasoning,omitempty"`
	TotalTokens int       `json:"totalTokens"`
	Cost        UsageCost `json:"cost"`
}

// EmptyUsage is no tokens at all.
func EmptyUsage() Usage { return Usage{} }

// ── Messages ────────────────────────────────────────────────────────────

// Message is one of the model's messages: SystemMessage, UserMessage, AssistantMessage or ToolResultMessage. The
// set is closed (an application's own kinds are agentcore's AgentMessage).
type Message interface {
	// Role is the JSON `role`.
	Role() string
	// Time is the JSON `timestamp` (milliseconds since the epoch).
	Time() int64
	llmMessage()
}

type SystemMessage struct {
	Content   UserContent
	Timestamp int64
}

type UserMessage struct {
	Content   UserContent
	Timestamp int64
}

type AssistantMessage struct {
	Content    []Content
	API        string
	Provider   string
	Model      string
	ResponseID string
	Usage      Usage
	StopReason StopReason
	// Set when it failed or was stopped.
	ErrorMessage string
	Timestamp    int64
	DurationMs   *int64
}

type ToolResultMessage struct {
	ToolCallID string
	ToolName   string
	Content    []Content
	// Anything the tool reports besides its content; nil leaves it out.
	Details    any
	IsError    bool
	Timestamp  int64
	DurationMs *int64
}

func (SystemMessage) Role() string     { return "system" }
func (UserMessage) Role() string       { return "user" }
func (AssistantMessage) Role() string  { return "assistant" }
func (ToolResultMessage) Role() string { return "toolResult" }

func (m SystemMessage) Time() int64     { return m.Timestamp }
func (m UserMessage) Time() int64       { return m.Timestamp }
func (m AssistantMessage) Time() int64  { return m.Timestamp }
func (m ToolResultMessage) Time() int64 { return m.Timestamp }

func (SystemMessage) llmMessage()     {}
func (UserMessage) llmMessage()       {}
func (AssistantMessage) llmMessage()  {}
func (ToolResultMessage) llmMessage() {}

// ToolCalls is the answer's tool calls, in order.
func (m AssistantMessage) ToolCalls() []Content {
	var out []Content
	for _, c := range m.Content {
		if c.Type == TypeToolCall {
			out = append(out, c)
		}
	}
	return out
}

func (m SystemMessage) MarshalJSON() ([]byte, error) {
	o := newObject()
	o.set("role", "system")
	o.set("content", m.Content)
	o.set("timestamp", m.Timestamp)
	return o.bytes(), nil
}

func (m UserMessage) MarshalJSON() ([]byte, error) {
	o := newObject()
	o.set("role", "user")
	o.set("content", m.Content)
	o.set("timestamp", m.Timestamp)
	return o.bytes(), nil
}

func (m AssistantMessage) MarshalJSON() ([]byte, error) {
	o := newObject()
	o.set("role", "assistant")
	content := m.Content
	if content == nil {
		content = []Content{}
	}
	o.set("content", content)
	o.set("api", m.API)
	o.set("provider", m.Provider)
	o.set("model", m.Model)
	if m.ResponseID != "" {
		o.set("responseId", m.ResponseID)
	}
	o.set("usage", m.Usage)
	o.set("stopReason", m.StopReason)
	if m.ErrorMessage != "" {
		o.set("errorMessage", m.ErrorMessage)
	}
	o.set("timestamp", m.Timestamp)
	if m.DurationMs != nil {
		o.set("durationMs", *m.DurationMs)
	}
	return o.bytes(), nil
}

func (m ToolResultMessage) MarshalJSON() ([]byte, error) {
	o := newObject()
	o.set("role", "toolResult")
	o.set("toolCallId", m.ToolCallID)
	o.set("toolName", m.ToolName)
	content := m.Content
	if content == nil {
		content = []Content{}
	}
	o.set("content", content)
	if m.Details != nil {
		o.set("details", m.Details)
	}
	o.set("isError", m.IsError)
	o.set("timestamp", m.Timestamp)
	if m.DurationMs != nil {
		o.set("durationMs", *m.DurationMs)
	}
	return o.bytes(), nil
}

func (m *SystemMessage) UnmarshalJSON(data []byte) error {
	var wire struct {
		Content   UserContent `json:"content"`
		Timestamp int64       `json:"timestamp"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*m = SystemMessage{Content: wire.Content, Timestamp: wire.Timestamp}
	return nil
}

func (m *UserMessage) UnmarshalJSON(data []byte) error {
	var wire struct {
		Content   UserContent `json:"content"`
		Timestamp int64       `json:"timestamp"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*m = UserMessage{Content: wire.Content, Timestamp: wire.Timestamp}
	return nil
}

func (m *AssistantMessage) UnmarshalJSON(data []byte) error {
	var wire struct {
		Content      []Content  `json:"content"`
		API          string     `json:"api"`
		Provider     string     `json:"provider"`
		Model        string     `json:"model"`
		ResponseID   string     `json:"responseId"`
		Usage        Usage      `json:"usage"`
		StopReason   StopReason `json:"stopReason"`
		ErrorMessage string     `json:"errorMessage"`
		Timestamp    int64      `json:"timestamp"`
		DurationMs   *int64     `json:"durationMs"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Content == nil {
		wire.Content = []Content{}
	}
	*m = AssistantMessage(wire)
	return nil
}

func (m *ToolResultMessage) UnmarshalJSON(data []byte) error {
	var wire struct {
		ToolCallID string    `json:"toolCallId"`
		ToolName   string    `json:"toolName"`
		Content    []Content `json:"content"`
		Details    any       `json:"details"`
		IsError    bool      `json:"isError"`
		Timestamp  int64     `json:"timestamp"`
		DurationMs *int64    `json:"durationMs"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Content == nil {
		wire.Content = []Content{}
	}
	*m = ToolResultMessage(wire)
	return nil
}

// DecodeMessage reads one of the model's messages by its role.
func DecodeMessage(data []byte) (Message, error) {
	var head struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, err
	}
	switch head.Role {
	case "system":
		var m SystemMessage
		err := json.Unmarshal(data, &m)
		return m, err
	case "user":
		var m UserMessage
		err := json.Unmarshal(data, &m)
		return m, err
	case "assistant":
		var m AssistantMessage
		err := json.Unmarshal(data, &m)
		return m, err
	case "toolResult":
		var m ToolResultMessage
		err := json.Unmarshal(data, &m)
		return m, err
	}
	return nil, fmt.Errorf("not a model message: role %q", head.Role)
}

// ── Models ──────────────────────────────────────────────────────────────

// Api is how a provider is spoken to: "openai-completions", "anthropic-messages", or another a host adds.
type Api = string

// ThinkingLevel is how hard a model thinks: minimal, low, medium, high, xhigh, max. ModelThinkingLevel adds "off".
type ThinkingLevel = string

const (
	ThinkingOff     ThinkingLevel = "off"
	ThinkingMinimal ThinkingLevel = "minimal"
	ThinkingLow     ThinkingLevel = "low"
	ThinkingMedium  ThinkingLevel = "medium"
	ThinkingHigh    ThinkingLevel = "high"
	ThinkingXHigh   ThinkingLevel = "xhigh"
	ThinkingMax     ThinkingLevel = "max"
)

// ThinkingLevelMap is what a level is called by the provider; a nil value (TS null): the model does not have it;
// an absent key: called as it is.
type ThinkingLevelMap map[string]*string

// Compat is the endpoint's differences, named as pi names them: OpenAICompletionsCompat for `openai-completions`,
// AnthropicMessagesCompat for `anthropic-messages`. A nil pointer is the TS `undefined`.
type Compat struct {
	// Thinking models that want their earlier reasoning back (DeepSeek).
	RequiresReasoningContentOnAssistantMessages bool
	SupportsReasoningEffort                     *bool
	SupportsUsageInStreaming                    *bool
	// "max_completion_tokens" | "max_tokens" (default).
	MaxTokensField         string
	RequiresToolResultName bool
	// "openai" | "deepseek".
	ThinkingFormat string
	// Claude decides how much to think (an effort level), rather than a budget of thinking tokens.
	ForceAdaptiveThinking bool
	SupportsTemperature   *bool
}

// ModelCost is dollars per million tokens.
type ModelCost struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// Model is a model to talk to: plain data, so a host may use one not listed in MODELS.
type Model struct {
	ID       string
	Name     string
	API      Api
	Provider string
	BaseURL  string
	// Whether it thinks.
	Reasoning bool
	// "text", "image".
	Input            []string
	Cost             ModelCost
	ContextWindow    int
	MaxTokens        int
	ThinkingLevelMap ThinkingLevelMap
	Compat           *Compat
	Headers          map[string]string
}

func (m Model) compat() Compat {
	if m.Compat == nil {
		return Compat{}
	}
	return *m.Compat
}

func (m Model) takesImages() bool {
	for _, i := range m.Input {
		if i == "image" {
			return true
		}
	}
	return false
}

// ── A request ───────────────────────────────────────────────────────────

// Tool is a tool as the model sees it: its parameters are JSON Schema.
type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
}

// Context is a request: the system prompt ("" for none), the conversation, the tools.
type Context struct {
	SystemPrompt string
	Messages     []Message
	Tools        []Tool
}

// ToolChoice is "auto" or "none"; "" leaves it to the provider.
type ToolChoice = string

// StreamOptions are a request's options; zero values are TS's undefined.
type StreamOptions struct {
	// The key; else the provider's environment variable (DEEPSEEK_API_KEY...).
	APIKey string
	// "" for no thinking.
	Reasoning   ThinkingLevel
	MaxTokens   int
	Temperature *float64
	ToolChoice  ToolChoice
	// Retries of a request that failed before any of the answer came (429, 5xx, no connection). nil: 2.
	MaxRetries *int
	SessionID  string
	Headers    map[string]string
}

// ── A streamed answer ───────────────────────────────────────────────────

// Event types of a streamed answer.
const (
	EventStart         = "start"
	EventTextStart     = "text_start"
	EventTextDelta     = "text_delta"
	EventTextEnd       = "text_end"
	EventThinkingStart = "thinking_start"
	EventThinkingDelta = "thinking_delta"
	EventThinkingEnd   = "thinking_end"
	EventToolCallStart = "toolcall_start"
	EventToolCallDelta = "toolcall_delta"
	EventToolCallEnd   = "toolcall_end"
	EventDone          = "done"
	EventError         = "error"
)

// AssistantMessageEvent is one event of a streamed answer, TS's union flat: each but done and error carries
// Partial, the answer so far. It ends with done (Message) or error (Error), never by failing.
type AssistantMessageEvent struct {
	Type         string
	ContentIndex int
	// *_delta.
	Delta string
	// text_end, thinking_end: the block's whole text.
	Content string
	// toolcall_end.
	ToolCall Content
	Partial  AssistantMessage
	// done: stop, length or toolUse; error: aborted or error.
	Reason  StopReason
	Message AssistantMessage
	Error   AssistantMessage
}

// Final is the message a done or error event ends with.
func (e AssistantMessageEvent) Final() (AssistantMessage, bool) {
	switch e.Type {
	case EventDone:
		return e.Message, true
	case EventError:
		return e.Error, true
	}
	return AssistantMessage{}, false
}

// Snapshot is the answer as it stands after the event.
func (e AssistantMessageEvent) Snapshot() AssistantMessage {
	if m, ok := e.Final(); ok {
		return m
	}
	return e.Partial
}
