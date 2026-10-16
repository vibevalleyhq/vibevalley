package grok

import (
	"encoding/json"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func authMethodIDs(initialized jsonx.Record) []string {
	ids := []string{}
	methods, _ := initialized["authMethods"].([]any)
	for _, method := range methods {
		if id, ok := jsonx.AsRecord(method)["id"].(string); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

func includes(list []string, item string) bool {
	for _, entry := range list {
		if entry == item {
			return true
		}
	}
	return false
}

// SelectAuthMethod is grok's preferred auth method when it offers it, else
// `cached_token`; "" for none.
func SelectAuthMethod(initialized jsonx.Record) string {
	ids := authMethodIDs(initialized)
	if preferred, ok := jsonx.Get(initialized, "_meta", "defaultAuthMethodId").(string); ok && includes(ids, preferred) {
		return preferred
	}
	if includes(ids, "cached_token") {
		return "cached_token"
	}
	return ""
}

// InitializeMeta is grok's `initialize` `_meta`. Grok 1.0.46 chooses
// override OR rules: both prompts are carried in the override, so native
// creation and resume each receive the complete requested prompt.
func InitializeMeta(options oar.SessionOptions) jsonx.Record {
	override := options.SystemPrompt
	if options.SystemPrompt != nil && options.AppendSystemPrompt != nil {
		joined := *options.SystemPrompt + "\n\n" + *options.AppendSystemPrompt
		override = &joined
	}
	meta := jsonx.Record{
		"clientIdentifier": "oar",
		"clientType":       "generic",
		"startupHints":     jsonx.Record{"nonInteractive": true, "skipGitStatus": true, "skipProjectLayout": true},
	}
	if override != nil {
		meta["systemPromptOverride"] = *override
	} else if options.AppendSystemPrompt != nil {
		meta["rules"] = *options.AppendSystemPrompt
	}
	return meta
}

func firstNumber(record jsonx.Record, names ...string) *int64 {
	for _, name := range names {
		if value := jsonx.Int64(record, name); value != nil {
			return value
		}
	}
	return nil
}

// ContextUsage reads the authoritative usage snapshot grok prompt answers
// carry in `_meta`: `totalTokens` is grok's running context count;
// `usage` is the prompt's multi-call billing ledger, not context fullness.
func ContextUsage(response jsonx.Record) *oar.ContextUsage {
	meta := jsonx.AsRecord(response["_meta"])
	tokens := firstNumber(meta, "totalTokens", "contextTokens")
	window := firstNumber(meta, "contextWindow", "context_window", "maxContextTokens")
	if tokens == nil && window == nil {
		return nil
	}
	return &oar.ContextUsage{Tokens: tokens, ContextWindow: window, Percent: acp.RoundedPercent(tokens, window)}
}

// PromptTokens is what one prompt answer bills: `_meta.usage` is the
// prompt's ledger summed over its model calls (grok 1.0.25: three one-word
// turns billed ~16.8k input each, not a growing total). `inputTokens`
// includes the cached reads and may include a child's model calls when it
// finishes during the parent prompt. The turn machinery shares its
// accumulator with independent root wake ledgers (spontaneous_usage.go).
// `cachedReadTokens` is the cache-read part, `cacheCreationTokens` the
// cache-write part, each read only when the ledger carries it. Both sides
// or nothing: a half ledger would invent a 0 for the missing side.
func PromptTokens(response jsonx.Record) *oar.TokenTotals {
	usage := jsonx.AsRecord(jsonx.AsRecord(response["_meta"])["usage"])
	input := firstNumber(usage, "inputTokens", "input_tokens")
	output := firstNumber(usage, "outputTokens", "output_tokens")
	if usage == nil || input == nil || output == nil {
		return nil
	}
	tokens := oar.TokenTotals{Input: *input, Output: *output}
	shared.CacheParts(&tokens, usage, "cachedReadTokens", "cacheCreationTokens")
	shared.ReasoningPart(&tokens, usage, "reasoningTokens")
	return &tokens
}

// ExtensionNotifications are the vendor notification methods to record, or
// they are dropped unseen. Each is recorded verbatim except MCP credential
// values; one that names a parent/child session pair links the graph.
//
// Observed live on grok 1.0.25 (2026-09-11): `_x.ai/session_notification`
// (the vendor twin of `session/update`: model_changed,
// session_summary_generated, tool_call_delta_chunk, pending_interaction,
// interaction_resolved, response_completed, turn_completed,
// last_turn_summary, background_tasks, and the sub-agent lifecycle),
// `_x.ai/sessions/changed`, `_x.ai/session/prompt_complete` and the
// per-start housekeeping. Still [sym] only (never on a live wire):
// `_x.ai/session/update`, `_x.ai/task_backgrounded`, `_x.ai/task_completed`,
// `_x.ai/session/usage`. Kept registered: an unlisted name is a dropped frame.
var ExtensionNotifications = []string{
	// live 2026-09-11
	"_x.ai/session_notification",
	"_x.ai/sessions/changed",
	"_x.ai/session/prompt_complete",
	"_x.ai/queue/changed",
	"_x.ai/models/update",
	"_x.ai/settings/update",
	"_x.ai/announcements/update",
	"_x.ai/mcp/servers_updated",
	"_x.ai/mcp/init_progress",
	"_x.ai/mcp/server_status",
	"_x.ai/mcp_initialized",
	// [sym] only
	"_x.ai/session/update",
	"_x.ai/task_backgrounded",
	"_x.ai/task_completed",
	"_x.ai/session/usage",
}

// RefusedSessionOptions are the options grok cannot honor.
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionAdditionalDirectories: "grok ACP exposes no effective additional workspace directory setting",
	oar.OptionServiceTier:           "grok exposes no verified per-session service-tier setting and readback",
	oar.OptionName:                  "grok exposes no verified session name setting",
	oar.OptionDisallowedTools:       "grok agent stdio does not forward the CLI tool denylist; supplying an agent profile would replace the user's selected harness rather than overlay its tools",
}

// RedactExtensionNotification keeps grok's MCP credential values out of the
// recorded notification; anything else is recorded verbatim.
func RedactExtensionNotification(method string, params json.RawMessage) json.RawMessage {
	if !shared.RedactionCovers(method) {
		return params
	}
	return jsonx.Marshal(shared.RedactGrokNotification(method, jsonx.ParseRecord(params)))
}

var yes = true

// Profile is grok's ACP profile (grokAcpProfile).
var Profile = acp.Profile{
	Args:             acp.StaticArgs("agent", "--always-approve", "--no-leader", "stdio"),
	IsResumeNotFound: func(native jsonx.Record, _ *bool) bool { return jsonx.Get(native, "data", "code") == "FS_NOT_FOUND" },
	// `grok agent [OPTIONS] stdio [OPTIONS]`: agent options (--model,
	// --agent-profile, --plugin-dir, ...) go before `stdio`, which itself
	// takes only --debug and --leader-socket.
	WithLaunchArgs: func(args, launchArgs []string) []string {
		out := append([]string{}, args[:len(args)-1]...)
		out = append(out, launchArgs...)
		return append(out, args[len(args)-1:]...)
	},
	// Native children are independent ACP sessions on the same connection
	// (attribution tier #3): recorded under their own session id, linked in
	// the graph when a lifecycle notification says so. Images despite
	// `initialize` saying `promptCapabilities.image: false`: grok 1.0.44
	// hands an ACP image block to the model (docs/runtimes/grok.md).
	Capabilities:                acp.Capabilities{Attribution: "nested", Images: &yes},
	ExtensionNotifications:      ExtensionNotifications,
	RedactExtensionNotification: RedactExtensionNotification,
	FailureOutcome:              FailureOutcome,
	TerminalShellCommand:        true,
	InitializeMeta:              InitializeMeta,
	ValidateOptions: func(options oar.SessionOptions) error {
		if err := shared.RefuseSessionOptions(RefusedSessionOptions, options); err != nil {
			return err
		}
		if options.Resume != "" && options.AppendSystemPrompt != nil && options.SystemPrompt == nil {
			return &oar.UnsupportedOptionError{Option: "appendSystemPrompt", Message: "grok does not reapply rules when resuming a session (observed on 1.0.46)"}
		}
		return nil
	},
	SessionMeta:      func(oar.SessionOptions) jsonx.Record { return jsonx.Record{"yoloMode": true} },
	SelectAuthMethod: SelectAuthMethod,
	// `_meta.sendNow` is not an injection: grok answers the running prompt
	// `cancelled` (`cancelTrigger: "send_now"`, live 1.0.25) and starts a
	// fresh model turn that re-issued the interrupted tool calls; both
	// answers fold into the one oar turn (turns.go).
	SteerParams:           func(string) jsonx.Record { return jsonx.Record{"_meta": jsonx.Record{"sendNow": true}} },
	SteerSupersedesPrompt: true,
	PromptMeta: func(options oar.SessionOptions) jsonx.Record {
		if len(options.OutputSchema) == 0 {
			return nil
		}
		return jsonx.Record{"outputSchema": options.OutputSchema}
	},
	PromptOutcome:         PromptOutcome,
	PromptContextUsage:    ContextUsage,
	PromptTokenUsage:      PromptTokens,
	SpontaneousTokenUsage: SpontaneousTokens,
}

// Session opens a grok session (`grok agent stdio`).
var Session = acp.Session(Profile)
