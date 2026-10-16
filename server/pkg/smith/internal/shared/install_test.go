package shared

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

type fakeInstallation struct {
	target string
	state  string
	plan   oar.InstallPlanner
	probe  oar.InstallationProbe
}

// fakeInstall is a vendor installer (fixtures/fake-installer.mjs) and a
// probe that looks only where it installs.
func fakeInstall(t *testing.T, dir, name, mode string) fakeInstallation {
	t.Helper()
	node := nodeOrSkip(t)
	state := filepath.Join(dir, name+".json")
	target := filepath.Join(dir, name)
	writeState(t, state, map[string]any{"target": target, "mode": mode})
	plan := func(context.Context, oar.InstallOptions) (oar.InstallPlan, error) {
		return oar.InstallPlan{
			Kind:   "plan",
			Steps:  []oar.InstallStep{{Command: []string{node, fixture(t, "fake-installer.mjs"), state}, Display: "install " + name}},
			Source: "https://example.invalid/install",
		}, nil
	}
	probe := ExecutableInstallation("OAR_FIXTURE_INSTALL_BIN", "oar-fixture-not-on-path", Fallbacks(target), nil, ExecutableInstallationOptions{})
	return fakeInstallation{target, state, plan, probe}
}

func install(t *testing.T, fake fakeInstallation, lineOf InstallLineOf, options oar.InstallOptions) oar.InstallResult {
	t.Helper()
	result, err := PlanInstaller(fake.probe, fake.plan, lineOf)(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestInstallIsJudgedByTheProbeAfterwards(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	fake := fakeInstall(t, dir, "installs", "install")
	t.Setenv("npm_config_user_agent", "pnpm/11.22.0")
	jsonEqual(t, install(t, fake, nil, oar.InstallOptions{}), `{"kind":"installed","installation":{"kind":"available","via":"executable","command":`+jsonText(fake.target)+`,"version":"fake 1.0.0"},"output":"Installed fake 1.0.0\n"}`)
	if readState(t, fake.state)["sawUserAgent"] != false {
		t.Fatal("the installer saw the package script marker")
	}
}

func TestAnInstallationFoundFirstMeansNoInstallerRuns(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	fake := fakeInstall(t, dir, "present", "fail")
	script(t, dir, "present", "echo 'fake 0.9.0'\n")
	jsonEqual(t, install(t, fake, nil, oar.InstallOptions{}), `{"kind":"already_installed","installation":{"kind":"available","via":"executable","command":`+jsonText(fake.target)+`,"version":"fake 0.9.0"}}`)
	if _, ran := readState(t, fake.state)["ran"]; ran {
		t.Fatal("the installer ran")
	}

	other := fakeInstall(t, dir, "other-line", "install")
	script(t, dir, "other-line", "echo 'opencode v2.0.26'\n")
	lineOf := func(installation oar.AvailableInstallation) string {
		if installation.Via == "executable" && regexp.MustCompile(` v2\.`).MatchString(installation.Version) {
			return "v2"
		}
		return "v1"
	}
	jsonEqual(t, install(t, other, lineOf, oar.InstallOptions{Line: "v1"}), `{"kind":"already_installed","installation":{"kind":"available","via":"executable","command":`+jsonText(other.target)+`,"version":"opencode v2.0.26"},"line":"v2"}`)
	if _, ran := readState(t, other.state)["ran"]; ran {
		t.Fatal("the installer ran")
	}
}

func TestInstallFailures(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	jsonEqual(t, install(t, fakeInstall(t, dir, "elsewhere", "elsewhere"), nil, oar.InstallOptions{}), `{"kind":"failed","exitCode":0,"output":"fake installed successfully!\n"}`)
	jsonEqual(t, install(t, fakeInstall(t, dir, "fails", "fail"), nil, oar.InstallOptions{}), `{"kind":"failed","exitCode":3,"output":"error: failed to download fake\n"}`)
	after := install(t, fakeInstall(t, dir, "fails-after", "fail-after"), nil, oar.InstallOptions{})
	if after.Kind != "installed" || after.Output != "Installed fake 1.0.0\nerror: could not write shell completions\n" {
		t.Fatalf("a non-zero exit after the runtime is in place is installed: %+v", after)
	}
	started := time.Now()
	prompts := install(t, fakeInstall(t, dir, "prompts", "prompt"), nil, oar.InstallOptions{Timeout: 20 * time.Second})
	if prompts.Kind != "failed" || time.Since(started) >= 15*time.Second {
		t.Fatalf("an installer that prompts reads end of input: %+v", prompts)
	}
}

func TestUnsupportedPlanIsTheInstallsAnswer(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	fake := fakeInstall(t, dir, "unsupported", "install")
	unsupported := oar.InstallPlan{
		Kind: "unsupported", Reason: "missing_tool", Detail: "curl",
		Steps:  []oar.InstallStep{{Command: []string{"node", fixture(t, "fake-installer.mjs"), filepath.Join(dir, "unsupported.json")}, Display: "install unsupported"}},
		Source: "https://example.invalid/install",
	}
	fake.plan = UnsupportedInstallPlan(unsupported)
	result := install(t, fake, nil, oar.InstallOptions{})
	jsonEqual(t, result, jsonText(unsupported))
	if exists(fake.target) {
		t.Fatal("something ran")
	}
}

func TestTimedOutInstallerIsStoppedWithEverythingItStarted(t *testing.T) {
	posixOnly(t)
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	dir := t.TempDir()
	fake := fakeInstall(t, dir, "hangs", "hang")
	// Long enough for the fake installer to start its worker on a loaded machine.
	result := install(t, fake, nil, oar.InstallOptions{Timeout: 5 * time.Second})
	if result.Kind != "failed" || result.ExitCode != nil || !regexp.MustCompile(`stopped the installer after 5000 ms`).MatchString(result.Output) {
		t.Fatalf("result = %+v", result)
	}
	worker, ok := readState(t, fake.state)["workerPid"].(float64)
	if !ok {
		t.Fatal("the fake reported no worker")
	}
	if !eventually(5*time.Second, func() bool { return !pidRunning(int(worker)) }) {
		t.Fatalf("worker %v survived", worker)
	}
}

var scriptMethod = ScriptInstallMethod{
	Source:  "https://example.invalid/docs",
	Line:    "curl -fsSL https://example.invalid/install.sh | bash",
	Tools:   []string{"curl", "bash"},
	Writes:  func() []string { return []string{"/home/oar/.example/bin", "/home/oar/.example"} },
	Windows: "Example documents, in PowerShell: irm https://example.invalid/install.ps1 | iex",
}

var linuxHost = InstallHost{
	Platform:   "linux",
	Arch:       "arm64",
	Locate:     func(tool string) string { return "/usr/bin/" + tool },
	Unwritable: func(string) string { return "" },
}

func TestScriptPlanRunsTheDocumentedLineThroughSh(t *testing.T) {
	jsonEqual(t, ScriptInstallPlanOn(scriptMethod, linuxHost), `{"kind":"plan","steps":[{"command":["sh","-c",`+jsonText(scriptMethod.Line)+`],"display":`+jsonText(scriptMethod.Line)+`}],"source":"https://example.invalid/docs","network":true,"privileges":false}`)
}

func TestScriptPlanOffPlatformHasNoSteps(t *testing.T) {
	windows := linuxHost
	windows.Platform, windows.Arch = "win32", "x64"
	freebsd := linuxHost
	freebsd.Platform = "freebsd"
	ia32 := linuxHost
	ia32.Arch = "ia32"
	answers := []oar.InstallPlan{ScriptInstallPlanOn(scriptMethod, windows), ScriptInstallPlanOn(scriptMethod, freebsd), ScriptInstallPlanOn(scriptMethod, ia32)}
	if !regexp.MustCompile(`irm https://example\.invalid/install\.ps1`).MatchString(answers[0].Detail) {
		t.Fatalf("windows = %+v", answers[0])
	}
	for _, answer := range answers {
		if answer.Kind != "unsupported" || answer.Reason != "platform" {
			t.Fatalf("answer = %+v", answer)
		}
		encoded := jsonText(answer)
		if regexp.MustCompile(`"steps"|"source"`).MatchString(encoded) {
			t.Fatalf("an off-platform answer carries the script: %s", encoded)
		}
	}
}

func TestMissingToolOrUnwritableDirKeepsTheSteps(t *testing.T) {
	planned := ScriptInstallPlanOn(scriptMethod, linuxHost)
	noCurl := linuxHost
	noCurl.Locate = func(tool string) string {
		if tool == "curl" {
			return ""
		}
		return "/usr/bin/" + tool
	}
	jsonEqual(t, ScriptInstallPlanOn(scriptMethod, noCurl), `{"kind":"unsupported","reason":"missing_tool","detail":"curl","steps":`+jsonText(planned.Steps)+`,"source":`+jsonText(planned.Source)+`}`)
	locked := linuxHost
	locked.Unwritable = func(target string) string {
		if target == "/home/oar/.example" {
			return "/home/oar"
		}
		return ""
	}
	jsonEqual(t, ScriptInstallPlanOn(scriptMethod, locked), `{"kind":"unsupported","reason":"requires_privileges","detail":"the installer writes /home/oar/.example, and /home/oar is not writable by this user","steps":`+jsonText(planned.Steps)+`,"source":`+jsonText(planned.Source)+`}`)
}

func TestLinesAndOneLinePlanners(t *testing.T) {
	ctx := context.Background()
	single, _ := ScriptInstallPlan(scriptMethod, linuxHost)(ctx, oar.InstallOptions{Line: "v2"})
	if single.Kind != "unsupported" || single.Reason != "unknown_line" || single.Detail != `this runtime ships one release line; leave line "v2" out` {
		t.Fatalf("single = %+v", single)
	}
	lined := LinedInstallPlan(LinedInstallMethods{
		Lines:   []oar.InstallLine{{Line: "v1"}, {Line: "v2"}},
		Methods: map[string]ScriptInstallMethod{"v1": scriptMethod, "v2": scriptMethod},
	}, linuxHost)
	unchosen, _ := lined(ctx, oar.InstallOptions{})
	unknown, _ := lined(ctx, oar.InstallOptions{Line: "v3"})
	if unchosen.Reason != "line_required" || unchosen.Detail != "choose a release line: v1, v2" || unknown.Reason != "unknown_line" || unknown.Detail != `"v3" is not one of v1, v2` {
		t.Fatalf("unchosen = %+v, unknown = %+v", unchosen, unknown)
	}
	for _, answer := range []oar.InstallPlan{unchosen, unknown} {
		if regexp.MustCompile(`"steps"|"source"`).MatchString(jsonText(answer)) {
			t.Fatalf("without a line it ships, there is no vendor step: %s", jsonText(answer))
		}
	}
	if v2, _ := lined(ctx, oar.InstallOptions{Line: "v2"}); v2.Kind != "plan" {
		t.Fatalf("v2 = %+v", v2)
	}
	if InstallDir("", "/fallback") != "/fallback" || InstallDir("/set", "/fallback") != "/set" {
		t.Fatal("installDir")
	}
}

func TestUnwritableAncestor(t *testing.T) {
	posixOnly(t)
	if os.Geteuid() == 0 {
		t.Skip("root writes everywhere")
	}
	dir := t.TempDir()
	locked := filepath.Join(dir, "locked")
	if err := os.Mkdir(locked, 0o555); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chmod(locked, 0o755) }()
	if got := UnwritableAncestor(filepath.Join(dir, "free", "bin")); got != "" {
		t.Fatalf("free = %q", got)
	}
	if got := UnwritableAncestor(filepath.Join(locked, "kimi-code", "bin")); got != locked {
		t.Fatalf("locked = %q", got)
	}
}
