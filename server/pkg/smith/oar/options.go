package oar

import (
	"encoding/json"
)

// McpServer is one MCP server a session attaches, in ACP's McpServer shape:
// a stdio server (Command, Args, Env) or a streamable HTTP one (Type "http",
// URL, Headers).
type McpServer struct {
	Name    string            `json:"name"`
	Type    string            `json:"type,omitempty"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// IsHTTP reports a streamable HTTP server.
func (s McpServer) IsHTTP() bool { return s.Type == "http" }

// SessionOptions is how a session opens (contracts/session-options.ts). What
// a runtime cannot honor is refused (UnsupportedOptionError), never dropped.
type SessionOptions struct {
	// Working directory the runtime operates in.
	Cwd string `json:"cwd"`
	// Additional workspace directories, resolved relative to Cwd.
	AdditionalDirectories []string `json:"additionalDirectories,omitempty"`
	// Runtime-native model identifier; the runtime's default when empty.
	Model string `json:"model,omitempty"`
	// Runtime-native reasoning-effort level for every turn.
	Effort string `json:"effort,omitempty"`
	// Runtime-native service tier, or "default".
	ServiceTier string `json:"serviceTier,omitempty"`
	// JSON Schema for the session's final output, passed through unchanged.
	OutputSchema json.RawMessage `json:"outputSchema,omitempty"`
	// Display name in the runtime's own UI (nil: none given).
	Name *string `json:"name,omitempty"`
	// Resume the native conversation identified by a previous Session.ID().
	Resume string `json:"resume,omitempty"`
	// Environment changes for the processes this session spawns: a value
	// sets the variable, nil removes it from the inherited environment.
	Env map[string]*string `json:"env,omitempty"`
	// Replace the runtime's built-in system prompt (nil: keep it).
	SystemPrompt *string `json:"systemPrompt,omitempty"`
	// Append to the runtime's built-in system prompt (nil: nothing).
	AppendSystemPrompt *string     `json:"appendSystemPrompt,omitempty"`
	MCPServers         []McpServer `json:"mcpServers,omitempty"`
	// Runtime-native tool names to disable through the runtime's deny channel.
	DisallowedTools []string `json:"disallowedTools,omitempty"`
	// Extra command-line arguments for the runtime process. Never recorded.
	LaunchArgs []string `json:"-"`
}

// String is a helper for optional string options.
func String(v string) *string { return &v }

// RefusableSessionOption names an option a runtime can refuse at open.
type RefusableSessionOption string

const (
	OptionSystemPrompt          RefusableSessionOption = "systemPrompt"
	OptionAppendSystemPrompt    RefusableSessionOption = "appendSystemPrompt"
	OptionEnv                   RefusableSessionOption = "env"
	OptionMCPServers            RefusableSessionOption = "mcpServers"
	OptionDisallowedTools       RefusableSessionOption = "disallowedTools"
	OptionLaunchArgs            RefusableSessionOption = "launchArgs"
	OptionServiceTier           RefusableSessionOption = "serviceTier"
	OptionAdditionalDirectories RefusableSessionOption = "additionalDirectories"
	OptionOutputSchema          RefusableSessionOption = "outputSchema"
	OptionName                  RefusableSessionOption = "name"
)

// RefusedSessionOptions maps each refused option to the reason session() rejects with.
type RefusedSessionOptions map[RefusableSessionOption]string

// Given reports the options in o that are "given" in the refusal sense:
// strings and pointers set, lists and maps non-empty.
func (o SessionOptions) Given(option RefusableSessionOption) bool {
	switch option {
	case OptionSystemPrompt:
		return o.SystemPrompt != nil
	case OptionAppendSystemPrompt:
		return o.AppendSystemPrompt != nil
	case OptionEnv:
		return len(o.Env) > 0
	case OptionMCPServers:
		return len(o.MCPServers) > 0
	case OptionDisallowedTools:
		return len(o.DisallowedTools) > 0
	case OptionLaunchArgs:
		return len(o.LaunchArgs) > 0
	case OptionServiceTier:
		return o.ServiceTier != ""
	case OptionAdditionalDirectories:
		return len(o.AdditionalDirectories) > 0
	case OptionOutputSchema:
		return len(o.OutputSchema) > 0
	case OptionName:
		return o.Name != nil
	}
	return false
}

// ─── Typed open errors (contracts/*-error.ts) ──────────────────────────────

// UnsupportedOptionError: session() was given an option the runtime cannot honor.
type UnsupportedOptionError struct {
	Option  string
	Message string
}

func (e *UnsupportedOptionError) Error() string { return e.Message }

// SessionNotFoundError: resume could not find the requested native conversation.
type SessionNotFoundError struct {
	SessionID string
	Message   string
	Method    string
	Native    json.RawMessage
}

func (e *SessionNotFoundError) Error() string { return e.Message }

// SessionUnavailableError: the runtime keeps the resume target but will not open it now.
type SessionUnavailableError struct {
	SessionID string
	Message   string
	// "archived" | "in_use"
	Reason string
	Method string
	Native json.RawMessage
}

func (e *SessionUnavailableError) Error() string { return e.Message }

// RuntimeFailureError: the open failed for a cause a failed turn would carry as failure.
type RuntimeFailureError struct {
	Failure    FailureClass
	Reason     string
	Credential CredentialProblem
	Status     *int
	Cause      error
}

func (e *RuntimeFailureError) Error() string { return e.Reason }
func (e *RuntimeFailureError) Unwrap() error { return e.Cause }
