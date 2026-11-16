package oar

import (
	"context"
	"strings"
)

// QoderDriver drives Qoder CLI over bidirectional stream-json while isolating prompts
// and MCP credentials in 0600 files inside a 0700 temporary directory (never in argv)
// and forcing QODER_EXPOSE_TOKEN_USAGE=1.
type QoderDriver struct{}

// NewQoderDriver constructs the Qoder runtime driver.
func NewQoderDriver() QoderDriver { return QoderDriver{} }

// ID returns "qoder".
func (QoderDriver) ID() string { return "qoder" }

// RefusedOptions declares session options refused prior to spawning qoder.
func (QoderDriver) RefusedOptions() RefusedOptions {
	return RefusedOptions{
		OptionEffort:                "qoder stream-json does not accept a session effort setting",
		OptionName:                  "qoder stream-json has no session name option",
		OptionServiceTier:           "qoder CLI has no serviceTier flag",
		OptionAdditionalDirectories: "qoder stream-json does not support additionalDirectories",
		OptionOutputSchema:          "qoder stream-json does not support outputSchema",
		OptionLaunchArgs:            "qoder driver does not accept raw launchArgs",
	}
}

// Open validates options pre-spawn, materializes 0600 prompt/MCP files inside a 0700 dir,
// sets QODER_EXPOSE_TOKEN_USAGE=1, and launches qoder stream-json.
func (d QoderDriver) Open(ctx context.Context, opts SessionOptions) (Session, error) {
	if err := ValidateOptions(d.ID(), d.RefusedOptions(), opts); err != nil {
		return nil, err
	}

	cmd := opts.BinPath
	if cmd == "" {
		cmd = "qoder"
	}

	args := []string{
		"--input-format", "stream-json",
		"--output-format", "stream-json",
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
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

	var secrets *secretDir
	needSecrets := opts.SystemPrompt != "" || opts.AppendSystemPrompt != "" || len(opts.MCPServers) > 0
	if needSecrets {
		var err error
		secrets, err = newSecretDir("oar-qoder-*")
		if err != nil {
			return nil, err
		}
		if opts.SystemPrompt != "" {
			p, err := secrets.writeFile("system-prompt.txt", []byte(opts.SystemPrompt))
			if err != nil {
				secrets.close()
				return nil, err
			}
			args = append(args, "--system-prompt-file", p)
		}
		if opts.AppendSystemPrompt != "" {
			p, err := secrets.writeFile("append-system-prompt.txt", []byte(opts.AppendSystemPrompt))
			if err != nil {
				secrets.close()
				return nil, err
			}
			args = append(args, "--append-system-prompt-file", p)
		}
		if len(opts.MCPServers) > 0 {
			mcpBytes, err := marshalMCPConfigFile(opts.MCPServers)
			if err != nil {
				secrets.close()
				return nil, err
			}
			p, err := secrets.writeFile("mcp-config.json", mcpBytes)
			if err != nil {
				secrets.close()
				return nil, err
			}
			args = append(args, "--mcp-config", p)
		}
	}

	spec := LaunchSpec{
		Command: cmd,
		Args:    args,
		Dir:     opts.CWD,
		Env: buildEnv(opts, map[string]string{
			EnvQoderExposeTokenUsage: "1",
		}),
	}

	cfg := streamJSONConfig{
		runtimeID:        d.ID(),
		supportsSteer:    false,
		supportsCompact:  true,
		supportsStopTask: true,
		usageIsPerTurn:   true,
	}
	return startStreamJSONSession(ctx, cfg, spec, opts, secrets)
}
