// Package ai is shaped and named as pi-ai 1.1.0 (role `toolResult`, content `toolCall`, events `text_delta`, stop reason `toolUse`...), so a pi
// transcript and ours read the same.
package ai

import (
	"encoding/json"
	"fmt"
)

const (
	TypeText     = "text"
	TypeThinking = "thinking"
	TypeImage    = "image"
	TypeToolCall = "toolCall"
)

// Only the fields of its type are written to JSON.
type Content struct {
	Type string

	Text          string
	TextSignature string

	Thinking          string
	ThinkingSignature string
	Redacted          bool

	// Data is base64.
	Data     string
	MimeType string

	// toolCall: Arguments is always a JSON object ({} when there are none), its keys in the order the model gave them.
	ID        string
	Name      string
	Arguments json.RawMessage
}

func NewText(text string) Content { return Content{Type: TypeText, Text: text} }

func NewThinking(thinking string) Content { return Content{Type: TypeThinking, Thinking: thinking} }

func NewImage(data, mimeType string) Content {
	return Content{Type: TypeImage, Data: data, MimeType: mimeType}
}

func NewToolCall(id, name string, arguments json.RawMessage) Content {
	return Content{Type: TypeToolCall, ID: id, Name: name, Arguments: arguments}
}

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

// Blocks nil means the string form.
type UserContent struct {
	Text   string
	Blocks []Content
}

func StringContent(text string) UserContent { return UserContent{Text: text} }

func BlocksContent(blocks ...Content) UserContent {
	if blocks == nil {
		blocks = []Content{}
	}
	return UserContent{Blocks: blocks}
}

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

type StopReason string

const (
	StopStop    StopReason = "stop"
	StopLength  StopReason = "length"
	StopToolUse StopReason = "toolUse"
	StopError   StopReason = "error"
	StopAborted StopReason = "aborted"
)

// In dollars.
type UsageCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Total      float64 `json:"total"`
}

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

func EmptyUsage() Usage { return Usage{} }

// The set is closed: an application's own kinds are agentcore's AgentMessage.
type Message interface {
	Role() string
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
	Content      []Content
	API          string
	Provider     string
	Model        string
	ResponseID   string
	Usage        Usage
	StopReason   StopReason
	ErrorMessage string
	Timestamp    int64
	DurationMs   *int64
}

type ToolResultMessage struct {
	ToolCallID string
	ToolName   string
	Content    []Content
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

type Api = string

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

// A nil value: the model does not have the level; an absent key: called as it is.
type ThinkingLevelMap map[string]*string

// A nil pointer is unset.
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

// Dollars per million tokens.
type ModelCost struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

type Model struct {
	ID               string
	Name             string
	API              Api
	Provider         string
	BaseURL          string
	Reasoning        bool
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

type Tool struct {
	Name        string
	Description string
	Parameters  map[string]any
}

type Context struct {
	SystemPrompt string
	Messages     []Message
	Tools        []Tool
}

// "" leaves it to the provider.
type ToolChoice = string

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

// Every event but done and error carries Partial. A stream ends with done or error, never by failing.
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

func (e AssistantMessageEvent) Final() (AssistantMessage, bool) {
	switch e.Type {
	case EventDone:
		return e.Message, true
	case EventError:
		return e.Error, true
	}
	return AssistantMessage{}, false
}

func (e AssistantMessageEvent) Snapshot() AssistantMessage {
	if m, ok := e.Final(); ok {
		return m
	}
	return e.Partial
}
