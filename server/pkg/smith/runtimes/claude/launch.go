package claude

import (
	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Starting the claude process for one session: SessionOptions as flags (launch.ts).
//
// SessionOptions.MCPServers is --mcp-config <path> (claude 2.1.292), handed
// over as mcp_config.go describes. The servers join the user's own, which
// stay loaded because oar never passes --strict-mcp-config; claude reports
// them in system/init as source "dynamic", and a dynamic server replaces a
// user-scope server of the same name for that process. The same flag goes
// on a --resume, which remembers none.

// claudeProcess is the process a claude session drives: what the adapter
// uses of executable.LineProcess. Line and exit handlers run on the
// process's own delivery goroutine, the exit after the last line; Kill
// never runs a handler on the calling goroutine.
type claudeProcess interface {
	Write(text string)
	OnLine(handler func(line string))
	OnExit(handler func(code *int))
	Kill()
	Exited() <-chan struct{}
	Resources() *executable.Resources
}

// spawnLineProcess starts a claude process; tests replace it with a scripted
// process (TS: vi.mock of spawnLineProcess).
var spawnLineProcess = func(command string, args []string, options executable.LineOptions) (claudeProcess, error) {
	process, err := executable.Spawn(command, args, options)
	if err != nil {
		return nil, err
	}
	return process, nil
}

func claudeArgs(sessionID string, options oar.SessionOptions, directories []string, mcpConfig string, tierArgs []string) []string {
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose", "--replay-user-messages", "--include-partial-messages",
		// YOLO by default (repo policy, 2026-08-24): in embedded/SDK use there is
		// no human at an approval prompt: a permission gate is a hang, not
		// safety. Isolation is the sandbox's job, not the approval flow's.
		"--dangerously-skip-permissions",
	}
	if options.Resume == "" {
		args = append(args, "--session-id", sessionID)
	} else {
		args = append(args, "--resume", sessionID)
	}
	// SessionOptions.Name (#368) names a new session only: --name on a resume
	// replaces the name the session has, which may be the user's.
	if options.Resume == "" && options.Name != nil {
		args = append(args, "--name", *options.Name)
	}
	if options.Model != "" {
		args = append(args, "--model", options.Model)
	}
	if options.Effort != "" {
		args = append(args, "--effort", options.Effort)
	}
	args = append(args, tierArgs...)
	if len(options.OutputSchema) > 0 {
		args = append(args, "--json-schema", string(compact(options.OutputSchema)))
	}
	if options.SystemPrompt != nil {
		args = append(args, "--system-prompt", *options.SystemPrompt)
	}
	if options.AppendSystemPrompt != nil {
		args = append(args, "--append-system-prompt", *options.AppendSystemPrompt)
	}
	// The host's own flags, unchecked (SessionOptions.LaunchArgs), ahead of
	// the variadic flags below so none swallows them as values.
	args = append(args, options.LaunchArgs...)
	if len(directories) > 0 {
		args = append(append(args, "--add-dir"), directories...)
	}
	if mcpConfig != "" {
		args = append(args, "--mcp-config", mcpConfig)
	}
	if len(options.DisallowedTools) > 0 {
		args = append(append(args, "--disallowed-tools"), options.DisallowedTools...)
	}
	return args
}

// launchClaude starts claude for a session (--session-id, or --resume an
// existing one); with MCP servers, their config is handed over as
// mcp_config.go describes and gone at the latest when the process exits. It
// errors on a list with an empty or repeated name, or launchArgs that
// collide with a flag OAR manages, before anything starts, and when claude
// cannot be spawned.
func launchClaude(command, sessionID string, options oar.SessionOptions) (claudeProcess, error) {
	if err := refuseManagedLaunchArgs(options.LaunchArgs); err != nil {
		return nil, err
	}
	if err := shared.CheckSessionName(options); err != nil {
		return nil, err
	}
	tierArgs, err := claudeServiceTierArgs(options.ServiceTier)
	if err != nil {
		return nil, err
	}
	directories, err := shared.ResolvedAdditionalDirectories(options)
	if err != nil {
		return nil, err
	}
	servers := shared.GivenMcpServers(options.MCPServers)
	// Either way, what dead hosts left behind goes first.
	var handoff *mcpConfigHandoff
	if servers != nil {
		made, err := handOverMcpConfig(servers)
		if err != nil {
			return nil, err
		}
		handoff = &made
	} else {
		sweepAbandonedMcpConfigs()
	}
	configPath := ""
	if handoff != nil {
		configPath = handoff.path
	}
	child, err := spawnLineProcess(command, claudeArgs(sessionID, options, directories, configPath, tierArgs), executable.LineOptions{
		Dir: options.Cwd,
		// Without the parent session's markers, so print mode chooses sdk-cli
		// and claude is not a child of the host's own claude (environment.go).
		Env: shared.Environment(claudeSessionEnv(options.Env)),
		// On Windows an npm .cmd wrapper can exit while native claude keeps
		// the provider request and stdio alive. Teardown must reach both.
		KillTree: true,
	})
	if err != nil {
		if handoff != nil {
			handoff.end()
		}
		return nil, err
	}
	if handoff != nil {
		// Fires once, for the exit, before Exited closes.
		end := handoff.end
		child.OnExit(func(*int) { end() })
		handoff.start()
	}
	return child, nil
}
