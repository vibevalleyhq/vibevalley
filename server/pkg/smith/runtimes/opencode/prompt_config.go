package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// PromptConfig is a session's prompts prepared as opencode configuration
// (prompt-config.ts OpenCodePromptConfig).
type PromptConfig struct {
	// The session options with the overlay in OPENCODE_CONFIG_CONTENT.
	Options oar.SessionOptions
	// The agent whose prompt the overlay replaces; "" when none.
	Agent string
	// Removes the session's instructions file; idempotent, and concurrent
	// calls all return once the removal has finished.
	Cleanup func()
}

// hasVariable reports whether environment ("NAME=value") sets name, even to "".
func hasVariable(environment []string, name string) bool {
	for _, entry := range environment {
		if key, _, found := strings.Cut(entry, "="); found && key == name {
			return true
		}
	}
	return false
}

// ValidatePrompts refuses prompt options opencode cannot take on this session.
func ValidatePrompts(options oar.SessionOptions) error {
	option := "appendSystemPrompt"
	if options.SystemPrompt != nil {
		option = "systemPrompt"
	}
	if options.SystemPrompt == nil && options.AppendSystemPrompt == nil {
		return nil
	}
	if hasVariable(shared.Environment(options.Env), "OPENCODE_CONFIG_CONTENT") {
		return &oar.UnsupportedOptionError{Option: option, Message: "opencode prompt options require OPENCODE_CONFIG_CONTENT, which is already set in the effective session environment"}
	}
	// An empty agent.prompt selects the built-in prompt in native request.ts.
	if options.SystemPrompt != nil && *options.SystemPrompt == "" {
		return &oar.UnsupportedOptionError{Option: "systemPrompt", Message: "opencode treats an empty agent prompt as its built-in prompt, so it cannot replace the system prompt with an empty string"}
	}
	return nil
}

func query(ctx context.Context, command string, args []string, options oar.SessionOptions, run Runner) (jsonx.Record, error) {
	result := run(ctx, command, args, executable.RunOptions{Dir: options.Cwd, Env: shared.Environment(options.Env), Timeout: 30 * time.Second})
	label := "opencode query"
	if len(args) > 0 {
		label = "opencode " + args[0]
	}
	if !result.OK {
		return nil, failureOf(label+" failed while resolving the session's agent", result)
	}
	var parsed any
	if err := json.Unmarshal([]byte(result.Stdout), &parsed); err != nil {
		return nil, errors.New(label + " returned invalid JSON while resolving the session's agent")
	}
	record := jsonx.AsRecord(parsed)
	if record == nil {
		return nil, errors.New(label + " returned no object while resolving the session's agent")
	}
	return record, nil
}

func savedAgent(exported jsonx.Record) (string, bool) {
	if durable, ok := jsonx.Get(exported, "info", "agent").(string); ok {
		return durable, true
	}
	var messages []jsonx.Record
	if list, ok := exported["messages"].([]any); ok {
		for _, message := range list {
			messages = append(messages, jsonx.AsRecord(jsonx.AsRecord(message)["info"]))
		}
	}
	for index := len(messages) - 1; index >= 0; index-- {
		message := messages[index]
		model := jsonx.AsRecord(message["model"])
		_, provider := model["providerID"].(string)
		_, modelID := model["modelID"].(string)
		if message["role"] == "user" && provider && modelID {
			agent, ok := message["agent"].(string)
			return agent, ok
		}
	}
	for index := len(messages) - 1; index >= 0; index-- {
		message := messages[index]
		_, provider := message["providerID"].(string)
		_, modelID := message["modelID"].(string)
		if !provider || !modelID {
			continue
		}
		agent := message["mode"]
		if agent == nil {
			agent = message["agent"]
		}
		name, ok := agent.(string)
		return name, ok
	}
	return "", false
}

func existingAgent(config jsonx.Record, agent string) (string, error) {
	// Only the two visible built-ins can be absent from resolved config. A
	// missing custom agent must not be recreated with default permissions by
	// our prompt-only overlay (including a stale saved/default agent name).
	if agent != "build" && agent != "plan" && jsonx.AsRecord(jsonx.AsRecord(config["agent"])[agent]) == nil {
		return "", &oar.UnsupportedOptionError{Option: "systemPrompt", Message: "opencode does not define agent " + jsonText(agent) + " in its resolved configuration; refusing to create an agent just to override its prompt"}
	}
	return agent, nil
}

func activeAgent(ctx context.Context, command string, options oar.SessionOptions, run Runner) (string, error) {
	config, err := query(ctx, command, []string{"debug", "config"}, options, run)
	if err != nil {
		return "", err
	}
	if options.Resume != "" {
		exported, err := query(ctx, command, []string{"export", options.Resume, "--sanitize"}, options, run)
		if err != nil {
			return "", err
		}
		if agent, ok := savedAgent(exported); ok {
			return existingAgent(config, agent)
		}
	}
	// Build is the native default without default_agent. If native selection
	// differs (disabled/renamed agents or a concurrent config change), the ACP
	// mode read-back refuses the open rather than dropping the override.
	agent := "build"
	if configured, ok := config["default_agent"].(string); ok && configured != "" {
		agent = configured
	}
	return existingAgent(config, agent)
}

// promptOverlay is the overlay in JSON.stringify's key order.
type promptOverlay struct {
	Agent        map[string]agentPrompt `json:"agent,omitempty"`
	Instructions []string               `json:"instructions,omitempty"`
}

type agentPrompt struct {
	Prompt string `json:"prompt"`
}

// PreparePrompts is a native config overlay only; it never copies, merges
// or rewrites user config (prepareOpenCodePrompts). A nil run uses the package
// runner.
func PreparePrompts(ctx context.Context, command string, options oar.SessionOptions, run Runner) (PromptConfig, error) {
	if run == nil {
		run = runExecutable
	}
	if err := ValidatePrompts(options); err != nil {
		return PromptConfig{}, err
	}
	agent := ""
	if options.SystemPrompt != nil {
		var err error
		if agent, err = activeAgent(ctx, command, options, run); err != nil {
			return PromptConfig{}, err
		}
	}
	// A private temp dir: a host that ends without disposing leaves it to the backstops there.
	var directory *shared.PrivateTempDir
	if options.AppendSystemPrompt != nil {
		var err error
		if directory, err = shared.NewPrivateTempDir("oar-opencode-prompt-"); err != nil {
			return PromptConfig{}, err
		}
	}
	var removal sync.Once
	cleanup := func() {
		if directory != nil {
			// Remove is synchronous: every caller returns once it is done.
			removal.Do(directory.Remove)
		}
	}
	overlay := promptOverlay{}
	if agent != "" {
		overlay.Agent = map[string]agentPrompt{agent: {Prompt: *options.SystemPrompt}}
	}
	if directory != nil {
		instructions := filepath.Join(directory.Path, "instructions.md")
		if err := os.WriteFile(instructions, []byte(*options.AppendSystemPrompt), 0o600); err != nil {
			cleanup()
			return PromptConfig{}, err
		}
		overlay.Instructions = []string{instructions}
	}
	// OpenCode interpolates {env:...}/{file:...} BEFORE parsing JSON. Escape
	// only those opening braces so prompt text survives literally, unchanged.
	content := jsonText(overlay)
	content = strings.ReplaceAll(content, "{env:", `\u007benv:`)
	content = strings.ReplaceAll(content, "{file:", `\u007bfile:`)
	prepared := options
	prepared.Env = make(map[string]*string, len(options.Env)+1)
	for name, value := range options.Env {
		prepared.Env[name] = value
	}
	prepared.Env["OPENCODE_CONFIG_CONTENT"] = &content
	return PromptConfig{Options: prepared, Agent: agent, Cleanup: cleanup}, nil
}

// VerifyAgent refuses an open whose selected agent is not the one the
// system prompt was configured for (verifyOpenCodeAgent).
func VerifyAgent(response jsonx.Record, expected string) error {
	var actual any
	found := false
	if options, ok := response["configOptions"].([]any); ok {
		for _, option := range options {
			if record := jsonx.AsRecord(option); record["category"] == "mode" {
				actual, found = record["currentValue"], true
				break
			}
		}
	}
	if !found || actual == nil {
		if value, ok := jsonx.AsRecord(response["modes"])["currentModeId"]; ok {
			actual = value
		}
	}
	if actual == expected {
		return nil
	}
	described := "<unreported>"
	if actual != nil {
		described = jsonText(actual)
	}
	return errors.New("opencode selected agent " + described + ", but the system prompt was configured for " + jsonText(expected))
}
