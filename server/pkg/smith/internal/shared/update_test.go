package shared

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// fakeRuntime is a runtime CLI with an updater (fixtures/fake-updater.mjs),
// driven by a state file in dir (fixtures/update-fixtures.ts).
func fakeRuntime(t *testing.T, dir, name string, state map[string]any) (command, stateFile string) {
	t.Helper()
	node := nodeOrSkip(t)
	stateFile = filepath.Join(dir, name+".json")
	writeState(t, stateFile, state)
	command = script(t, dir, name, `exec "`+node+`" "`+fixture(t, "fake-updater.mjs")+`" "`+stateFile+`" "$@"`+"\n")
	return command, stateFile
}

func fixedCheck(check oar.UpdateCheck) oar.UpdateChecker {
	return func(context.Context, oar.AvailableInstallation, oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
		return check, nil
	}
}

var updateAvailable = oar.UpdateCheck{Kind: "ok", Installed: "1.0.0", Latest: "1.1.0", UpdateAvailable: true, Source: "fixture"}

func fakeExecutable(command, version string) oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: command, Version: version}
}

func TestUpgradeIsJudgedByTheVersionAfterwards(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command, state := fakeRuntime(t, dir, "upgrades", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "upgrade"})
	t.Setenv("npm_config_user_agent", "pnpm/11.22.0")
	result, err := UpgradeExecutable(context.Background(), fakeExecutable(command, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(updateAvailable), Args: []string{"update", "--yes"}}, oar.UpgradeOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, result, `{"kind":"upgraded","from":"1.0.0","to":"1.1.0","output":"Updated to 1.1.0\n"}`)
	read := readState(t, state)
	if !reflect.DeepEqual(read["updateArgs"], []any{"--yes"}) || read["sawUserAgent"] != false {
		t.Fatalf("state = %v", read)
	}
}

func TestUpgradeOutcomes(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	noop, _ := fakeRuntime(t, dir, "noop", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "noop"})
	result, _ := UpgradeExecutable(context.Background(), fakeExecutable(noop, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(updateAvailable), Args: []string{"update"}}, oar.UpgradeOptions{})
	jsonEqual(t, result, `{"kind":"unchanged","version":"1.0.0","output":"Update ran successfully!\n"}`)

	fails, _ := fakeRuntime(t, dir, "fails", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "fail"})
	result, _ = UpgradeExecutable(context.Background(), fakeExecutable(fails, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(updateAvailable), Args: []string{"update"}}, oar.UpgradeOptions{})
	jsonEqual(t, result, `{"kind":"failed","exitCode":3,"output":"error: failed to download update\n"}`)

	prompts, _ := fakeRuntime(t, dir, "prompts", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "prompt"})
	started := time.Now()
	result, _ = UpgradeExecutable(context.Background(), fakeExecutable(prompts, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(updateAvailable), Args: []string{"update"}}, oar.UpgradeOptions{Timeout: 20 * time.Second})
	if result.Kind != "unchanged" || time.Since(started) >= 15*time.Second {
		t.Fatalf("an updater that prompts reads end of input: %+v", result)
	}

	unchecked, _ := fakeRuntime(t, dir, "unchecked", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "upgrade"})
	result, _ = UpgradeExecutable(context.Background(), fakeExecutable(unchecked, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed"}), Args: []string{"update"}}, oar.UpgradeOptions{})
	if result.Kind != "upgraded" {
		t.Fatalf("an unavailable check still lets the updater run: %+v", result)
	}

	result, _ = UpgradeExecutable(context.Background(), oar.AvailableInstallation{Via: "bundled"}, NativeUpdater{Check: fixedCheck(updateAvailable)}, oar.UpgradeOptions{})
	if result.Kind != "unsupported" || result.Reason != "unsupported_installation" {
		t.Fatalf("a bundled installation has no upgrade: %+v", result)
	}
}

func TestNoUpdaterRunsWhenCurrent(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command, state := fakeRuntime(t, dir, "current", map[string]any{"version": "1.1.0", "target": "1.1.0", "mode": "fail"})
	current := oar.UpdateCheck{Kind: "ok", Installed: "1.1.0", Latest: "1.1.0", UpdateAvailable: false, Source: "fixture"}
	result, _ := UpgradeExecutable(context.Background(), fakeExecutable(command, "fake 1.1.0"), NativeUpdater{Check: fixedCheck(current), Args: []string{"update"}}, oar.UpgradeOptions{})
	if result.Kind != "current" || result.Version != "1.1.0" || result.Check == nil || *result.Check != current {
		t.Fatalf("result = %+v", result)
	}
	if _, ran := readState(t, state)["updateArgs"]; ran {
		t.Fatal("the updater ran")
	}
}

// A check like the runtimes' own: the installed version from the installation, 1.1.0 released.
func checkFromInstallation(_ context.Context, installation oar.AvailableInstallation, _ oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
	update := ExecutableUpdateOf(installation)
	if update.Kind == "executable" {
		return ComparedCheck(update.Installed, "1.1.0", "fixture", ""), nil
	}
	return update.Check, nil
}

func TestSelfUpdatedExecutableIsJudgedByWhatItSaysNow(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	// Probed at 1.0.0; the runtime then updated itself in the background.
	command, state := fakeRuntime(t, dir, "self-updated", map[string]any{"version": "1.1.0", "target": "1.1.0", "mode": "noop"})
	result, _ := UpgradeExecutable(context.Background(), fakeExecutable(command, "fake 1.0.0"), NativeUpdater{Check: checkFromInstallation, Args: []string{"update"}}, oar.UpgradeOptions{})
	if result.Kind != "current" || result.Version != "1.1.0" || result.Check == nil ||
		*result.Check != (oar.UpdateCheck{Kind: "ok", Installed: "1.1.0", Latest: "1.1.0", UpdateAvailable: false, Source: "fixture"}) {
		t.Fatalf("result = %+v", result)
	}
	if _, ran := readState(t, state)["updateArgs"]; ran {
		t.Fatal("the updater ran")
	}
}

func TestTimedOutUpdaterIsStoppedWithEverythingItStarted(t *testing.T) {
	posixOnly(t)
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	dir := t.TempDir()
	command, state := fakeRuntime(t, dir, "hangs", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "hang"})
	result, _ := UpgradeExecutable(context.Background(), fakeExecutable(command, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(updateAvailable), Args: []string{"update"}}, oar.UpgradeOptions{Timeout: time.Second})
	if result.Kind != "failed" || result.Output == nil || !regexp.MustCompile(`stopped the updater after 1000 ms`).MatchString(*result.Output) {
		t.Fatalf("result = %+v", result)
	}
	worker, ok := readState(t, state)["workerPid"].(float64)
	if !ok {
		t.Fatal("the fake reported no worker")
	}
	if !eventually(5*time.Second, func() bool { return !pidRunning(int(worker)) }) {
		t.Fatalf("worker %v survived", worker)
	}
}

func TestReleaseVersions(t *testing.T) {
	for text, want := range map[string]string{
		"2.1.284 (Claude Code)":               "2.1.284",
		"codex-cli 0.158.0":                   "0.158.0",
		"grok 1.0.46 (2765805b9442) [stable]": "1.0.46",
		"0.161.0-alpha.9":                     "0.161.0-alpha.9",
		"opencode v2.0.26":                    "2.0.26",
		"no version here":                     "",
	} {
		if got := ReleaseVersion(text); got != want {
			t.Errorf("%q: %q, want %q", text, got, want)
		}
	}
	if !VersionAtLeast("0.43.0", "0.43.0") || !VersionAtLeast("2.1.1", "0.43.0") || VersionAtLeast("0.38.0", "0.43.0") {
		t.Error("versionAtLeast")
	}
	if !VersionAtLeast("1.2.0-beta.1", "1.2.0") || VersionAtLeast("1.x.0", "1.0.0") {
		t.Error("prerelease tags are ignored; a part that is no number fails")
	}
}

func TestUpdaterEnvDropsScriptMarkers(t *testing.T) {
	got := UpdaterEnv([]string{"PATH=/bin", "npm_config_user_agent=pnpm/11", "npm_lifecycle_event=check", "npm_config_prefix=/opt/npm"})
	if !reflect.DeepEqual(got, []string{"PATH=/bin", "npm_config_prefix=/opt/npm"}) {
		t.Fatalf("got %v", got)
	}
}

func TestComparedCheckAndExecutableUpdate(t *testing.T) {
	if got := ComparedCheck("1.0.0", "v1.1.0", "src", "stable"); got != (oar.UpdateCheck{Kind: "ok", Installed: "1.0.0", Latest: "1.1.0", UpdateAvailable: true, Channel: "stable", Source: "src"}) {
		t.Errorf("got %+v", got)
	}
	if got := ComparedCheck("1.0.0", "<html>nothing</html>", "src", ""); got != (oar.UpdateCheck{Kind: "unavailable", Reason: "version_unreadable", Detail: `no release version in "<html>nothing</html>"`, Source: "src"}) {
		t.Errorf("got %+v", got)
	}
	if got := ExecutableUpdateOf(fakeExecutable("x", "no version")); got.Kind != "unavailable" || got.Check.Reason != "version_unreadable" || got.Check.Detail != "x --version gave no release version" {
		t.Errorf("got %+v", got)
	}
	if got := ExecutableUpdateOf(oar.AvailableInstallation{Via: "bundled"}); got.Check.Reason != "unsupported_installation" {
		t.Errorf("got %+v", got)
	}
	if got := ExecutableUpdateOf(fakeExecutable("x", "x 1.2.3")); got.Kind != "executable" || got.Installed != "1.2.3" {
		t.Errorf("got %+v", got)
	}
}

func TestRunCheckCommandReadsJSON(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command := script(t, dir, "doctor", "echo '{\"overallStatus\":\"fail\"}'; exit 1\n")
	result, json := RunCheckCommand(context.Background(), command, nil, 5*time.Second)
	if result.ExitCode == nil || *result.ExitCode != 1 || json.(map[string]any)["overallStatus"] != "fail" {
		t.Fatalf("result = %+v, json = %v", result, json)
	}
	if got := InstalledPath(command); got == "" {
		t.Fatal("no installed path")
	}
	_ = os.Remove(command)
}

func TestReadReleaseSource(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest" {
			_, _ = w.Write([]byte("1.2.3\n"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	text, check := ReadReleaseSource(context.Background(), server.URL+"/latest", time.Second)
	if check != nil || text != "1.2.3\n" {
		t.Fatalf("text = %q, check = %+v", text, check)
	}
	_, check = ReadReleaseSource(context.Background(), server.URL+"/missing", time.Second)
	if check == nil || *check != (oar.UpdateCheck{Kind: "unavailable", Reason: "lookup_failed", Detail: "HTTP 404", Source: server.URL + "/missing"}) {
		t.Fatalf("check = %+v", check)
	}
	_, check = ReadReleaseSource(context.Background(), "http://127.0.0.1:1/unreachable", time.Second)
	if check == nil || check.Reason != "lookup_failed" || check.Detail == "" {
		t.Fatalf("check = %+v", check)
	}
}

// claude-update-env.test.ts, its shared half: a runtime's own Env still
// passes the script-context filter.
func TestUpdaterEnvRunsOnTopOfTheRuntimesEnv(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	command, state := fakeRuntime(t, dir, "env", map[string]any{"version": "1.0.0", "target": "1.1.0", "mode": "upgrade"})
	t.Setenv("CLAUDE_CODE_MESSAGING_TOKEN", "parent-session-token")
	t.Setenv("npm_config_user_agent", "pnpm/11.22.0")
	withoutToken := func() []string {
		var kept []string
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "CLAUDE_CODE_MESSAGING_TOKEN=") {
				kept = append(kept, entry)
			}
		}
		return kept
	}
	if _, err := UpgradeExecutable(context.Background(), fakeExecutable(command, "fake 1.0.0"), NativeUpdater{Check: fixedCheck(updateAvailable), Args: []string{"update"}, Env: withoutToken}, oar.UpgradeOptions{}); err != nil {
		t.Fatal(err)
	}
	read := readState(t, state)
	if read["sawMessagingToken"] != false || read["sawUserAgent"] != false {
		t.Fatalf("state = %v", read)
	}
}

func TestCurrentCheckJSON(t *testing.T) {
	jsonEqual(t, ComparedCheck("1.1.0", "1.1.0", "s", ""), `{"kind":"ok","installed":"1.1.0","latest":"1.1.0","updateAvailable":false,"source":"s"}`)
}
