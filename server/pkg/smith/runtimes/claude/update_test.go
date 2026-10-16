package claude

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Ports the claude cases of tests/update-sources.test.ts,
// tests/update-projections.test.ts, tests/installation.test.ts and
// tests/install-runtimes.test.ts.

func executableAt(command, version string) oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: command, Version: version}
}

func writeJSONFile(t *testing.T, file string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(jsonText(value)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestChecksTheChannelItsSettingsChooseAtTheSourceItsUpdaterReads(t *testing.T) {
	t.Setenv("DISABLE_UPDATES", "")
	server := startReleaseServer(t)
	dir := t.TempDir()
	configDir := filepath.Join(dir, "claude-config")
	writeJSONFile(t, filepath.Join(configDir, "settings.json"), map[string]any{"autoUpdatesChannel": "stable"})
	server.set("/claude/stable", 200, "2.1.285\n")
	check := claudeUpdateCheck(claudeUpdateSources{Releases: server.base + "/claude", Npm: server.base + "/npm",
		ConfigDir: func() string { return configDir }, GlobalConfig: func() string { return filepath.Join(configDir, ".claude.json") }})
	native, err := check(context.Background(), executableAt(filepath.Join(dir, "claude-native"), "2.1.286 (Claude Code)"), oar.UpdateCheckOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, native, `{"kind":"ok","installed":"2.1.286","latest":"2.1.285","updateAvailable":true,"channel":"stable","source":"`+server.base+`/claude/stable"}`)
	writeJSONFile(t, filepath.Join(configDir, "settings.json"), map[string]any{"env": map[string]any{"DISABLE_UPDATES": "1"}})
	disabled, err := check(context.Background(), executableAt(filepath.Join(dir, "claude-native"), "2.1.286 (Claude Code)"), oar.UpdateCheckOptions{})
	if err != nil || disabled.Kind != "unavailable" || disabled.Reason != "updates_disabled" {
		t.Fatalf("disabled = %+v %v", disabled, err)
	}
}

func TestACopyClaudeRecordsAsNpmFollowsTheNpmDistTagHeldByMinimumVersion(t *testing.T) {
	t.Setenv("DISABLE_UPDATES", "")
	server := startReleaseServer(t)
	dir := t.TempDir()
	configDir := filepath.Join(dir, "claude-npm-config")
	writeJSONFile(t, filepath.Join(configDir, "settings.json"), map[string]any{"autoUpdatesChannel": "stable", "minimumVersion": "2.1.286"})
	writeJSONFile(t, filepath.Join(configDir, ".claude.json"), map[string]any{"installMethod": "global"})
	server.set("/npm/stable", 200, jsonText(map[string]any{"name": "@anthropic-ai/claude-code", "version": "2.1.285"}))
	check := claudeUpdateCheck(claudeUpdateSources{Releases: server.base + "/claude", Npm: server.base + "/npm",
		ConfigDir: func() string { return configDir }, GlobalConfig: func() string { return filepath.Join(configDir, ".claude.json") }})
	// A pnpm shim: the path says nothing, the recorded method says npm.
	result, err := check(context.Background(), executableAt(filepath.Join(dir, "pnpm-bin", "claude"), "2.1.286 (Claude Code)"), oar.UpdateCheckOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, result, `{"kind":"ok","installed":"2.1.286","latest":"2.1.285","updateAvailable":false,"channel":"stable","source":"`+server.base+`/npm/stable"}`)
}

func TestInstallMethodComesFromTheExecutablesRealPath(t *testing.T) {
	for _, tc := range []struct {
		path     string
		recorded any
		want     string
	}{
		{"/home/u/.local/share/claude/versions/2.1.286", nil, "native"},
		{"/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", nil, "npm"},
		{"/opt/homebrew/Caskroom/claude-code/2.1.285/claude", nil, "package_manager"},
		// A shim whose path is not a layout defers to claude's recorded method.
		{"C:/Users/u/AppData/Roaming/npm/claude.cmd", "global", "npm"},
		{"/home/u/.local/share/claude/versions/2.1.286", "global", "native"},
	} {
		if got := claudeInstallKind(tc.path, tc.recorded); got != tc.want {
			t.Errorf("%s (%v) = %s, want %s", tc.path, tc.recorded, got, tc.want)
		}
	}
}

func TestCandidatesAreTheNativeInstallersLauncher(t *testing.T) {
	if got := claudeInstalledExecutableCandidates("linux", "/home/oar"); !reflect.DeepEqual(got, []string{"/home/oar/.local/bin/claude"}) {
		t.Fatalf("linux = %v", got)
	}
	if got := claudeInstalledExecutableCandidates("win32", `C:\Users\oar`); !reflect.DeepEqual(got, []string{`C:\Users\oar\.local\bin\claude.exe`}) {
		t.Fatalf("win32 = %v", got)
	}
}

func TestProbesThroughItsPinEnvVar(t *testing.T) {
	node := loginNodeOrSkip(t)
	t.Setenv("OAR_CLAUDE_BIN", node)
	snapshot, err := Installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	version, err := exec.Command(node, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Kind != "available" || snapshot.Available.Via != "executable" || snapshot.Available.Command != node || snapshot.Available.Version != strings.TrimSpace(string(version)) || len(snapshot.Available.Shadowed) != 0 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
}

func TestScriptInstallRunsTheVendorsDocumentedLine(t *testing.T) {
	linux := shared.InstallHost{Platform: "linux", Arch: "arm64", Locate: func(tool string) string { return "/usr/bin/" + tool }, Unwritable: func(string) string { return "" }}
	plan := shared.ScriptInstallPlanOn(claudeInstallMethod, linux)
	if plan.Kind != "plan" || len(plan.Steps) != 1 || plan.Steps[0].Display != "curl -fsSL https://claude.ai/install.sh | bash" || plan.Source != "https://code.claude.com/docs/en/setup" {
		t.Fatalf("plan = %+v", plan)
	}
}

func TestOneLineRuntimeRefusesALine(t *testing.T) {
	plan, err := Runtime().InstallPlan(context.Background(), oar.InstallOptions{Line: "v2"})
	if err != nil || plan.Kind != "unsupported" || plan.Reason != "unknown_line" {
		t.Fatalf("plan = %+v %v", plan, err)
	}
}

func TestInstallAndInstallPlanComeTogether(t *testing.T) {
	runtime := Runtime()
	if (runtime.Install == nil) != (runtime.InstallPlan == nil) || runtime.Install == nil {
		t.Fatal("claude must have both install and installPlan")
	}
}
