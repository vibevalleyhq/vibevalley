package oar

import (
	"context"
	"strings"
)

// QwenDriver drives Qwen Code over its bidirectional SDK stream-json channel.
type QwenDriver struct{}

// NewQwenDriver constructs the Qwen Code runtime driver.
func NewQwenDriver() QwenDriver { return QwenDriver{} }

// ID returns "qwen".
func (QwenDriver) ID() string { return "qwen" }

// RefusedOptions declares session options refused before spawning qwen.
func (QwenDriver) RefusedOptions() RefusedOptions {
	return RefusedOptions{
		OptionEffort:       "qwen SDK stream-json does not expose a session effort setting",
		OptionName:         "qwen SDK stream-json has no session name option",
		OptionServiceTier:  "qwen CLI has no serviceTier flag",
		OptionOutputSchema: "qwen SDK stream-json does not support outputSchema",
		OptionLaunchArgs:   "qwen driver does not accept raw launchArgs",
	}
}

// Open validates options pre-spawn, launches qwen --channel=SDK, and sends control initialize as frame 1.
func (d QwenDriver) Open(ctx context.Context, opts SessionOptions) (Session, error) {
	if err := ValidateOptions(d.ID(), d.RefusedOptions(), opts); err != nil {
		return nil, err
	}

	cmd := opts.BinPath
	if cmd == "" {
		cmd = "qwen"
	}

	args := []string{
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--channel=SDK",
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.SystemPrompt != "" {
		args = append(args, "--system-prompt", opts.SystemPrompt)
	}
	if opts.AppendSystemPrompt != "" {
		args = append(args, "--append-system-prompt", opts.AppendSystemPrompt)
	}
	if len(opts.AdditionalDirectories) > 0 {
		args = append(args, "--include-directories", strings.Join(opts.AdditionalDirectories, ","))
	}
	if len(opts.AllowedTools) > 0 {
		args = append(args, "--allowed-tools", strings.Join(opts.AllowedTools, ","))
	}
	if len(opts.DisallowedTools) > 0 {
		args = append(args, "--disallowed-tools", strings.Join(opts.DisallowedTools, ","))
	}
	if opts.ResumeSessionID != "" {
		args = append(args, "--resume", opts.ResumeSessionID)
	}

	initPayload := map[string]any{}
	if len(opts.MCPServers) > 0 {
		initPayload["mcpServers"] = qwenMCPServersPayload(opts.MCPServers)
	}

	spec := LaunchSpec{
		Command: cmd,
		Args:    args,
		Dir:     opts.CWD,
		Env:     buildEnv(opts, nil),
	}

	cfg := streamJSONConfig{
		runtimeID:           d.ID(),
		supportsSteer:       false,
		supportsCompact:     false,
		supportsStopTask:    true,
		usageIsPerTurn:      true,
		sendInitializeFirst: true,
		initializePayload:   initPayload,
	}
	return startStreamJSONSession(ctx, cfg, spec, opts, nil)
}

func qwenMCPServersPayload(servers []MCPServer) map[string]any {
	out := make(map[string]any, len(servers))
	for _, s := range servers {
		switch s.Type {
		case MCPHTTP:
			entry := map[string]any{
				"httpUrl": s.URL,
			}
			if len(s.Headers) > 0 {
				entry["headers"] = s.Headers
			}
			out[s.Name] = entry
		default:
			args := s.Args
			if args == nil {
				args = []string{}
			}
			entry := map[string]any{
				"command": s.Command,
				"args":    args,
			}
			if len(s.Env) > 0 {
				entry["env"] = s.Env
			}
			out[s.Name] = entry
		}
	}
	return out
}
