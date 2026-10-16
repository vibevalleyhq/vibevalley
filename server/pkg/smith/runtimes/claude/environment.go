// Package claude is the Claude Code runtime (packages/oar/src/runtimes/claude):
// claude driven over stream-json in print mode, plus its installation,
// update, login, model listing, account usage and inventory readers.
// Native mappings and live evidence: docs/runtimes/claude.md.
package claude

import (
	"os"
	"strings"
)

// ClaudeParentSessionMarkers are the variables a running Claude Code
// session sets for its own child processes (its Bash tool, hooks): markers
// of that parent session, not configuration (environment.ts). A host started
// from inside Claude Code inherits them, and a claude it launches then
// believes it is part of that session (CLAUDE_CODE_CHILD_SESSION: skill
// proposals off, org memory refused, no prompt history), runs under its
// entrypoint, or receives the parent's messaging credential. The list is the
// one claude itself drops when it launches an independent claude (its daemon
// launcher, 2.1.292), plus the messaging socket and token. TRACEPARENT
// (trace context) and an AI_AGENT set by another tool are configuration and
// pass through (#309).
var ClaudeParentSessionMarkers = []string{
	"CLAUDECODE",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_CHILD_SESSION",
	"CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
	"CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
	"CLAUDE_CODE_BRIDGE_SESSION_ID",
	"CLAUDE_CODE_HOST_WORKTREE",
	"CLAUDE_CODE_HOST_WORKTREE_FENCE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_MESSAGING_SOCKET",
	"CLAUDE_CODE_MESSAGING_TOKEN",
}

// claudeSessionEnv is a session's environment changes: every inherited
// parent-session marker removed, then the host's own SessionOptions.Env,
// which can set any of them again except CLAUDECODE (claude refuses to
// start nested under it).
func claudeSessionEnv(env map[string]*string) map[string]*string {
	out := make(map[string]*string, len(ClaudeParentSessionMarkers)+len(env))
	for _, name := range ClaudeParentSessionMarkers {
		out[name] = nil
	}
	for name, value := range env {
		out[name] = value
	}
	out["CLAUDECODE"] = nil
	return out
}

// claudeEnv is the environment for the claude subcommands OAR runs (auth,
// usage, model list, inventory): the host's, without parent-session markers.
func claudeEnv() []string {
	markers := map[string]bool{}
	for _, name := range ClaudeParentSessionMarkers {
		markers[name] = true
	}
	inherited := os.Environ()
	env := make([]string, 0, len(inherited))
	for _, entry := range inherited {
		name, _, _ := strings.Cut(entry, "=")
		if !markers[name] {
			env = append(env, entry)
		}
	}
	return env
}
