//go:build wip_a

package claude

import (
	"os"
	"reflect"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-launch-env.test.ts.

func launchedEnv(t *testing.T, env map[string]*string) []string {
	t.Helper()
	fake := newFakeProcess(nil)
	spawner := useFakeSpawner(t, fake)
	child, err := launchClaude("claude", "session", oar.SessionOptions{Cwd: "/work", Env: env})
	if err != nil {
		t.Fatal(err)
	}
	child.Kill()
	return spawner.call(0).options.Env
}

func TestInheritedEntrypointIsRemovedAndExplicitWins(t *testing.T) {
	for _, tc := range []struct {
		env      map[string]*string
		expected *string
	}{
		{nil, nil},
		{map[string]*string{"CLAUDE_CODE_ENTRYPOINT": oar.String("claude-desktop")}, oar.String("claude-desktop")},
		{map[string]*string{"CLAUDE_CODE_ENTRYPOINT": nil}, nil},
		{map[string]*string{"CLAUDE_CODE_ENTRYPOINT": oar.String("")}, oar.String("")},
	} {
		t.Setenv("CLAUDE_CODE_ENTRYPOINT", "claude-vscode")
		t.Setenv("CLAUDECODE", "parent-session")
		env := launchedEnv(t, tc.env)
		value, ok := envOf(env, "CLAUDE_CODE_ENTRYPOINT")
		if (tc.expected == nil) != !ok || (ok && value != *tc.expected) {
			t.Fatalf("entrypoint = %q %v, want %v", value, ok, tc.expected)
		}
		if _, ok := envOf(env, "CLAUDECODE"); ok {
			t.Fatal("CLAUDECODE passed")
		}
		if got := []string{os.Getenv("CLAUDE_CODE_ENTRYPOINT"), os.Getenv("CLAUDECODE")}; !reflect.DeepEqual(got, []string{"claude-vscode", "parent-session"}) {
			t.Fatalf("host env changed: %v", got)
		}
	}
}

// inheritParentSession sets every marker as a parent Claude Code session
// would, plus two variables that are configuration.
func inheritParentSession(t *testing.T) {
	for _, name := range ClaudeParentSessionMarkers {
		t.Setenv(name, "parent-"+name)
	}
	t.Setenv("TRACEPARENT", "00-trace-span-01")
	t.Setenv("AI_AGENT", "other-tool/1.0")
}

// #309: every inherited parent-session marker is removed; trace context and
// another tool's AI_AGENT pass; explicit env wins.
func TestEveryInheritedParentSessionMarkerIsRemoved(t *testing.T) {
	inheritParentSession(t)
	env := launchedEnv(t, map[string]*string{"CLAUDE_CODE_SESSION_ID": oar.String("host-chosen"), "CLAUDECODE": oar.String("host-tried")})
	kept := []string{}
	for _, name := range ClaudeParentSessionMarkers {
		if _, ok := envOf(env, name); ok {
			kept = append(kept, name)
		}
	}
	if !reflect.DeepEqual(kept, []string{"CLAUDE_CODE_SESSION_ID"}) {
		t.Fatalf("kept = %v", kept)
	}
	got := []string{}
	for _, name := range []string{"CLAUDE_CODE_SESSION_ID", "TRACEPARENT", "AI_AGENT"} {
		value, _ := envOf(env, name)
		got = append(got, value)
	}
	if !reflect.DeepEqual(got, []string{"host-chosen", "00-trace-span-01", "other-tool/1.0"}) {
		t.Fatalf("env = %v", got)
	}
}

func TestClaudeSubcommandsGetTheHostEnvironmentWithoutMarkers(t *testing.T) {
	inheritParentSession(t)
	env := claudeEnv()
	for _, name := range ClaudeParentSessionMarkers {
		if _, ok := envOf(env, name); ok {
			t.Fatalf("%s passed", name)
		}
	}
	if value, _ := envOf(env, "TRACEPARENT"); value != "00-trace-span-01" {
		t.Fatalf("TRACEPARENT = %q", value)
	}
	if os.Getenv("CLAUDE_CODE_CHILD_SESSION") != "parent-CLAUDE_CODE_CHILD_SESSION" {
		t.Fatal("host env changed")
	}
}
