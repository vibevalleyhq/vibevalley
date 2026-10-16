package pi

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// RefusedSessionOptions are the options pi cannot honor, refused before
// anything opens (open.ts piRefusedSessionOptions).
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionOutputSchema:          "Pi SDK exposes no final-output schema option",
	oar.OptionAdditionalDirectories: "pi's SDK configures one cwd and exposes no additional workspace directory option",
	oar.OptionServiceTier:           "pi exposes no verified per-session service-tier setting and readback",
	oar.OptionLaunchArgs:            "pi runs in this process through its SDK; there is no runtime command line to add arguments to",
}

// ThinkingLevels are pi's thinking levels (pi-ai EXTENDED_THINKING_LEVELS).
var ThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// ThinkingLevel checks SessionOptions.Effort against pi's levels before pi
// sees it: pi clamps a word it does not know to the model's lowest level.
func ThinkingLevel(effort string) (string, error) {
	for _, level := range ThinkingLevels {
		if level == effort {
			return level, nil
		}
	}
	return "", fmt.Errorf("pi has no thinking level %s (pi's levels: %s)", effort, strings.Join(ThinkingLevels, ", "))
}

// SupportedThinkingLevels is pi-ai's getSupportedThinkingLevels(model) over a
// Model object as pi's RPC returns it.
func SupportedThinkingLevels(model jsonx.Record) []string {
	if reasoning, _ := jsonx.Bool(model, "reasoning"); !reasoning {
		return []string{"off"}
	}
	levelMap := jsonx.AsRecord(model["thinkingLevelMap"])
	var levels []string
	for _, level := range ThinkingLevels {
		mapped, present := levelMap[level]
		if present && mapped == nil {
			continue
		}
		if (level == "xhigh" || level == "max") && !present {
			continue
		}
		levels = append(levels, level)
	}
	return levels
}

// piMCPServerName is the names pi takes; its tool namespace folds `-` into `_`.
var piMCPServerName = regexp.MustCompile(`^[\w-]+$`)

// LiteralConfigValue escapes a value pi would otherwise resolve: a leading
// `!` runs as a shell command, `$NAME` interpolates; `$$` and `$!` are literal.
func LiteralConfigValue(value string) string {
	return strings.NewReplacer("$", "$$", "!", "$!").Replace(value)
}

func literalValues(values map[string]string) map[string]string {
	out := make(map[string]string, len(values))
	for key, value := range values {
		out[key] = LiteralConfigValue(value)
	}
	return out
}

// mcpEnvironment: pi's MCP config can override strings but cannot remove inherited variables.
func mcpEnvironment(env map[string]*string) (map[string]string, error) {
	values := map[string]string{}
	for key, value := range env {
		if value == nil {
			return nil, &oar.UnsupportedOptionError{Option: "env", Message: "pi's stdio MCP servers re-inherit the host environment and cannot remove variables; env removals cannot be combined with stdio mcpServers"}
		}
		values[key] = *value
	}
	return values, nil
}

// MCPServerConfig is one entry as pi's MCP server config (mcp.ts
// piMcpServerConfig): every value literal, every tool declared directly.
func MCPServerConfig(server oar.McpServer, sessionEnv map[string]*string) (jsonx.Record, error) {
	if server.IsHTTP() {
		config := jsonx.Record{"type": "http", "url": server.URL, "exposure": "direct"}
		if server.Headers != nil {
			config["headers"] = literalValues(server.Headers)
		}
		return config, nil
	}
	env, err := mcpEnvironment(sessionEnv)
	if err != nil {
		return nil, err
	}
	for key, value := range server.Env {
		env[key] = value
	}
	args := server.Args
	if args == nil {
		args = []string{}
	}
	config := jsonx.Record{"type": "stdio", "command": server.Command, "args": args, "exposure": "direct"}
	if len(env) > 0 {
		config["env"] = literalValues(env)
	}
	return config, nil
}

func validateMCPEnvironment(options oar.SessionOptions) error {
	for _, server := range shared.GivenMcpServers(options.MCPServers) {
		if !server.IsHTTP() {
			_, err := mcpEnvironment(options.Env)
			return err
		}
	}
	return nil
}

func checkMCPServerNames(servers []oar.McpServer) error {
	if err := shared.CheckMcpServerNames(servers); err != nil {
		return err
	}
	namespaces := map[string]string{}
	for _, server := range servers {
		quoted, _ := json.Marshal(server.Name)
		if !piMCPServerName.MatchString(server.Name) {
			return fmt.Errorf("pi registers no MCP server named %s: its names match %s", quoted, piMCPServerName.String())
		}
		namespace := strings.ReplaceAll(server.Name, "-", "_")
		if other, ok := namespaces[namespace]; ok {
			otherQuoted, _ := json.Marshal(other)
			return fmt.Errorf("pi would give the MCP servers %s and %s one tool namespace (mcp__%s)", otherQuoted, quoted, namespace)
		}
		namespaces[namespace] = server.Name
	}
	return nil
}

// openJob is the host's open job (open.ts openPiAgentSession's inputs):
// options already checked here, the MCP servers as pi's own configs.
func openJob(options oar.SessionOptions, agentDir string) (jsonx.Record, error) {
	job := jsonx.Record{"type": "open", "cwd": options.Cwd, "agentDir": agentDir}
	if options.Resume != "" {
		job["resume"] = options.Resume
	}
	if options.Model != "" {
		job["model"] = options.Model
	}
	if options.Effort != "" {
		job["thinkingLevel"] = options.Effort
	}
	if options.SystemPrompt != nil {
		job["systemPrompt"] = *options.SystemPrompt
	}
	if options.AppendSystemPrompt != nil {
		job["appendSystemPrompt"] = *options.AppendSystemPrompt
	}
	if options.Env != nil {
		job["env"] = options.Env
	}
	if options.DisallowedTools != nil {
		job["disallowedTools"] = options.DisallowedTools
	}
	if options.Name != nil {
		job["name"] = *options.Name
	}
	if servers := shared.GivenMcpServers(options.MCPServers); len(servers) > 0 {
		if err := checkMCPServerNames(servers); err != nil {
			return nil, err
		}
		entries := make([][2]any, 0, len(servers))
		for _, server := range servers {
			config, err := MCPServerConfig(server, options.Env)
			if err != nil {
				return nil, err
			}
			entries = append(entries, [2]any{server.Name, config})
		}
		job["mcpServers"] = entries
	}
	return job, nil
}

// openFailure is the error a refused open job carries, typed as TS types it.
func openFailure(err error, resume string) error {
	var refused *commandError
	if !errors.As(err, &refused) {
		return err
	}
	switch refused.code {
	case "session_not_found":
		return &oar.SessionNotFoundError{SessionID: resume, Message: refused.message, Method: "SessionManager.list", Native: refused.native}
	case "model_unavailable":
		return &oar.RuntimeFailureError{Failure: oar.FailureModelUnavailable, Reason: refused.message}
	}
	return errors.New(refused.message)
}
