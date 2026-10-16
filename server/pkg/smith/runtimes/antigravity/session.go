package antigravity

import (
	"bytes"
	"encoding/json"
	"runtime"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// AcpArgs is the ACP registry's launch line for agy_acp_server 1.2.1. On
// Linux the binary's startup drops privileges to group `nobody` unless
// `--uid=` is empty, and on a host without that group it aborts before
// speaking ACP ("Check failed: LookupGIDByGroupName"). macOS and Windows take no args.
func AcpArgs(goos string) []string {
	if goos == "linux" {
		return []string{"--uid="}
	}
	return []string{}
}

// SupportsYolo: agy_acp_server 1.2.1 lists `yolo` both as a session mode and
// as a value of its `mode` config option; either way `session/set_mode` applies it.
func SupportsYolo(response jsonx.Record) bool {
	for _, mode := range jsonx.AsRecordList(jsonx.Get(response, "modes", "availableModes")) {
		if mode["id"] == "yolo" {
			return true
		}
	}
	for _, option := range jsonx.AsRecordList(response["configOptions"]) {
		if option["id"] != "mode" {
			continue
		}
		for _, value := range jsonx.AsRecordList(option["options"]) {
			if value["value"] == "yolo" {
				return true
			}
		}
		break
	}
	return false
}

// RefusedSessionOptions are the options antigravity refuses at open.
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionOutputSchema:          "Antigravity ACP and launch configuration expose no final-output schema channel",
	oar.OptionName:                  "antigravity exposes no verified session name setting",
	oar.OptionAdditionalDirectories: "antigravity accepts but ignores ACP additionalDirectories",
	oar.OptionServiceTier:           "antigravity exposes no verified per-session service-tier setting and readback",
	oar.OptionSystemPrompt:          "The Antigravity ACP server has no system prompt override in its protocol, launch options, or configuration",
	oar.OptionAppendSystemPrompt:    "The Antigravity ACP server has no system prompt append input in its protocol, launch options, or configuration",
}

// jsonText is JSON.stringify: no HTML escaping.
func jsonText(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return string(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
}

// RefuseMcpCredentials refuses SessionOptions.MCPServers entries carrying a
// credential. agy_acp_server 1.3.0 writes a session's `mcpServers`, `env`
// and `headers` values included, in plain text into its conversation
// database (`$GEMINI_HOME/antigravity-acp/conversations/<id>.db`, 0600),
// which outlives the session and which a host cannot see or clear through
// ACP; credentials reach a runtime only through its native channel, never
// its disk. An entry without `env` or `headers` attaches as usual.
func RefuseMcpCredentials(options oar.SessionOptions) error {
	for _, server := range options.MCPServers {
		if shared.HasMcpCredentials(server) {
			return &oar.UnsupportedOptionError{Option: "mcpServers", Message: "antigravity stores a session's MCP servers, env and header values included, in plain text in its conversation database, where they outlive the session; it attaches no entry with env or headers (" + jsonText(server.Name) + ")"}
		}
	}
	return nil
}

// filterNames are the canonical BuiltinTools values in agy_acp_server
// 1.3.0's distributed types.py. Native tool_filter.py logs and ignores other
// names, so the open fails before launch. A validation set, never an
// allowlist sent to the runtime.
var filterNames = map[string]bool{
	"list_directory": true, "search_directory": true, "find_file": true, "view_file": true, "create_file": true, "edit_file": true,
	"run_command": true, "ask_question": true, "start_subagent": true, "generate_image": true, "search_web": true, "read_url_content": true, "schedule": true, "finish": true,
}

// ToolDenials refuses disallowedTools antigravity's disabledTools cannot filter.
func ToolDenials(options oar.SessionOptions) error {
	unsupported := []string{}
	for _, name := range options.DisallowedTools {
		if !filterNames[name] {
			unsupported = append(unsupported, name)
		}
	}
	if len(unsupported) > 0 {
		return &oar.UnsupportedOptionError{Option: "disallowedTools", Message: "antigravity disabledTools only filters canonical built-in names; MCP, client tools and unknown names cannot be disabled: " + jsonText(unsupported)}
	}
	return nil
}

// Profile is antigravityAcpProfile.
var Profile = acp.Profile{
	Args: func(oar.SessionOptions) []string { return AcpArgs(runtime.GOOS) },
	IsResumeNotFound: func(native jsonx.Record, _ *bool) bool {
		code, ok := jsonx.Num(native, "code")
		return ok && code == -32002
	},
	// Subagents run inside the harness and never reach ACP under their own
	// ids: opaque (tier #1). The method set has no steer, so the profile has
	// no SteerParams and the session no Steer.
	Capabilities: acp.Capabilities{Attribution: "opaque"},
	// Startup unpacks a large Python archive; the first initialize can take
	// several seconds on a cold disk.
	RequestTimeout: 30 * time.Second,
	// No `authenticate`: the server signs in from the `auth.type` its own
	// login persisted plus the cached token, or from GEMINI_API_KEY.
	ValidateOptions: func(options oar.SessionOptions) error {
		if err := shared.RefuseSessionOptions(RefusedSessionOptions, options); err != nil {
			return err
		}
		if err := RefuseMcpCredentials(options); err != nil {
			return err
		}
		return ToolDenials(options)
	},
	// TS sends the meta whenever disallowedTools is given, [] included; Go
	// tells a given empty list (non-nil, as JSON `[]` decodes) from an absent one (nil).
	SessionMeta: func(options oar.SessionOptions) jsonx.Record {
		if options.DisallowedTools == nil {
			return nil
		}
		return jsonx.Record{"agy": map[string]any{"disabledTools": append([]string{}, options.DisallowedTools...)}}
	},
	// `session/set_model` answers `{}` and no `config_option_update` is ever
	// pushed, so only `set_config_option` reports the switch. Effort is part
	// of the model id and no `thought_level` option exists.
	ModelViaConfigOption: true,
	// A resumed session comes back in mode `default`, so yolo is applied on
	// every open, not only on `session/new`.
	ConfigureSession: func(configure acp.ConfigureContext) error {
		if SupportsYolo(configure.Response) {
			_, err := configure.Request(acp.MethodSessionSetMode, map[string]any{"sessionId": configure.SessionID, "modeId": "yolo"})
			return err
		}
		return nil
	},
}

// Session opens an antigravity session.
var Session = acp.Session(Profile)
