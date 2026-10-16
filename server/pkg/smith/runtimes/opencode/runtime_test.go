package opencode

// opencode's cases of the cross-runtime TS tests: tests/install-runtimes.test.ts,
// additional-directories.test.ts and inventory.test.ts.

import (
	"context"
	"errors"
	"testing"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

var linuxHost = shared.InstallHost{Platform: "linux", Arch: "arm64", Locate: func(tool string) string { return "/usr/bin/" + tool }, Unwritable: func(string) string { return "" }}

func TestEachLinesScriptInstallRunsItsDocumentedLineCitedByItsDocumentationPage(t *testing.T) {
	for line, want := range map[string][2]string{
		"v1": {"curl -fsSL https://opencode.ai/install | bash", "https://opencode.ai/docs/#install"},
		"v2": {"curl -fsSL https://opencode.ai/v2/install | bash", "https://opencode.ai/v2/docs/"},
	} {
		plan := shared.ScriptInstallPlanOn(InstallMethods[line], linuxHost)
		if plan.Kind != "plan" || len(plan.Steps) != 1 || plan.Steps[0].Display != want[0] || plan.Source != want[1] {
			t.Fatalf("%s: %+v", line, plan)
		}
	}
}

func TestOpencodeShipsTwoLinesAndOARPicksNeitherThePlanNeedsALine(t *testing.T) {
	jsonEqual(t, Runtime().InstallLines, `[{"line": "v1", "description": "OpenCode 1: the opencode-ai 1.x releases"}, {"line": "v2", "description": "OpenCode 2: the @opencode/cli 2.x releases, with a new plugin and server API"}]`)
	unchosen, err := InstallPlan(context.Background(), oar.InstallOptions{})
	if err != nil || unchosen.Kind != "unsupported" || unchosen.Reason != "line_required" {
		t.Fatalf("%+v %v", unchosen, err)
	}
	unknown, err := InstallPlan(context.Background(), oar.InstallOptions{Line: "v3"})
	if err != nil || unknown.Kind != "unsupported" || unknown.Reason != "unknown_line" {
		t.Fatalf("%+v %v", unknown, err)
	}
	// Without a line it ships, there is no vendor step to show.
	for _, answer := range []oar.InstallPlan{unchosen, unknown} {
		if answer.Steps != nil || answer.Source != "" {
			t.Fatalf("%+v", answer)
		}
	}
	// A plan for v2 here, or this machine's own answer (platform on Windows), never line_required.
	v2, err := InstallPlan(context.Background(), oar.InstallOptions{Line: "v2"})
	if err != nil || (v2.Kind == "plan" && v2.Source != "https://opencode.ai/v2/docs/") || (v2.Kind != "plan" && v2.Reason == "line_required") {
		t.Fatalf("%+v %v", v2, err)
	}
}

func TestAnInstallationsLineIsItsMajorVersion(t *testing.T) {
	found := func(version string) oar.AvailableInstallation {
		return oar.AvailableInstallation{Via: "executable", Command: "opencode", Version: version}
	}
	for version, want := range map[string]string{"1.18.35": "v1", "opencode v2.0.26": "v2", "opencode v3.0.0": ""} {
		if got := LineOf(found(version)); got != want {
			t.Fatalf("%s: %q", version, got)
		}
	}
	if got := LineOf(oar.AvailableInstallation{Via: "bundled"}); got != "" {
		t.Fatal(got)
	}
}

func TestOpencodeV1RefusesDirectoriesBeforePreparingPromptsOrOpeningACP(t *testing.T) {
	runner := useRunner(t)
	cwd := t.TempDir()
	_, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/does-not-exist", Version: "1.18.35"}, oar.SessionOptions{Cwd: cwd, AdditionalDirectories: []string{cwd + "/extra"}, SystemPrompt: oar.String("replace")})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "additionalDirectories" {
		t.Fatalf("%#v", err)
	}
	if len(runner.recorded()) != 0 {
		t.Fatal("queried")
	}
}

func TestOpencodeHasNoIndependentCommandQueryOnItsSelectedTransport(t *testing.T) {
	commands, err := Runtime().Commands(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/opencode"}, oar.InventoryOptions{})
	if err != nil || commands.Kind != "unsupported" || commands.Code != "transport_unavailable" {
		t.Fatalf("%+v %v", commands, err)
	}
}
