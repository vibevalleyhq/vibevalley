package oar

import (
	"context"
	"strings"
)

// ClaudeDriver drives Claude Code over bidirectional stream-json stdio.
type ClaudeDriver struct{}

// NewClaudeDriver constructs the Claude Code runtime driver.
func NewClaudeDriver() ClaudeDriver { return ClaudeDriver{} }

// ID returns "claude".
func (ClaudeDriver) ID() string { return "claude" }

// RefusedOptions declares session options rejected prior to spawning claude.
func (ClaudeDriver) RefusedOptions() RefusedOptions {
	return RefusedOptions{
		OptionName:        "claude stream-json driver does not set a session display name",
		OptionServiceTier: "claude CLI has no serviceTier flag",
		OptionLaunchArgs:  "claude driver does not accept raw launchArgs",
	}
}

// Open validates options pre-spawn, launches claude stream-json, and queries get_usage baseline on Resume.
func (d ClaudeDriver) Open(ctx context.Context, opts SessionOptions) (Session, error) {
	if err := ValidateOptions(d.ID(), d.RefusedOptions(), opts); err != nil {
		return nil, err
	}

	cmd := opts.BinPath
	if cmd == "" {
		cmd = "claude"
	}

	args := []string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode", "bypassPermissions",
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.Effort != "" {
		args = append(args, "--effort", opts.Effort)
	}
	if opts.SystemPrompt != "" {
		args = append(args, "--system-prompt", opts.SystemPrompt)
	}
	if opts.AppendSystemPrompt != "" {
		args = append(args, "--append-system-prompt", opts.AppendSystemPrompt)
	}
	if len(opts.DisallowedTools) > 0 {
		args = append(args, "--disallowed-tools", strings.Join(opts.DisallowedTools, ","))
	}
	if len(opts.AllowedTools) > 0 {
		args = append(args, "--allowed-tools", strings.Join(opts.AllowedTools, ","))
	}
	for _, dir := range opts.AdditionalDirectories {
		args = append(args, "--add-dir", dir)
	}
	if len(opts.OutputSchema) > 0 {
		args = append(args, "--json-schema", string(opts.OutputSchema))
	}
	if opts.ResumeSessionID != "" {
		args = append(args, "--resume", opts.ResumeSessionID)
	}

	var secrets *secretDir
	if len(opts.MCPServers) > 0 {
		var err error
		secrets, err = newSecretDir("oar-claude-*")
		if err != nil {
			return nil, err
		}
		mcpBytes, err := marshalMCPConfigFile(opts.MCPServers)
		if err != nil {
			secrets.close()
			return nil, err
		}
		mcpPath, err := secrets.writeFile("mcp-config.json", mcpBytes)
		if err != nil {
			secrets.close()
			return nil, err
		}
		args = append(args, "--mcp-config", mcpPath)
	}

	spec := LaunchSpec{
		Command: cmd,
		Args:    args,
		Dir:     opts.CWD,
		Env:     buildEnv(opts, nil),
	}

	cfg := streamJSONConfig{
		runtimeID:          d.ID(),
		supportsSteer:      true,
		supportsCompact:    true,
		supportsStopTask:   true,
		probeUsageOnResume: true,
	}
	return startStreamJSONSession(ctx, cfg, spec, opts, secrets)
}
