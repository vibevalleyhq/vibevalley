package kimi

// kimi's cases of the cross-runtime TS tests: tests/installation.test.ts,
// install-runtimes.test.ts, update-sources.test.ts, update.test.ts,
// additional-directories.test.ts and inventory.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func TestCandidatesMatchTheOfficialNativeInstallerLayouts(t *testing.T) {
	jsonEqual(t, InstalledExecutableCandidates("darwin", "/Users/oar", map[string]string{"KIMI_INSTALL_DIR": "/opt/kimi-code"}),
		[]string{"/opt/kimi-code/bin/kimi", "/Users/oar/.kimi-code/bin/kimi", "kimi-code"})
	jsonEqual(t, InstalledExecutableCandidates("win32", `C:\Users\oar`, map[string]string{"KIMI_INSTALL_DIR": `D:\Kimi Code`}),
		[]string{`D:\Kimi Code\bin\kimi.exe`, `C:\Users\oar\.kimi-code\bin\kimi.exe`, "kimi-code"})
}

func TestKimiGatesItsACPEntrypoint(t *testing.T) {
	t.Setenv("OAR_KIMI_BIN", nodePath(t))
	snapshot, err := Installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "unsupported", "reason": "acp --help failed"})
}

var linuxHost = shared.InstallHost{Platform: "linux", Arch: "arm64", Locate: func(tool string) string { return "/usr/bin/" + tool }, Unwritable: func(string) string { return "" }}

func TestTheScriptInstallRunsMoonshotsDocumentedLineCitedByItsDocumentationPage(t *testing.T) {
	plan := shared.ScriptInstallPlanOn(InstallMethod, linuxHost)
	if plan.Kind != "plan" || len(plan.Steps) != 1 || plan.Steps[0].Display != "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" || plan.Source != "https://github.com/MoonshotAI/kimi-code#install" {
		t.Fatalf("%+v", plan)
	}
}

func TestAnInstallLocationVariableIsWherePrivilegesAreCheckedAndTheAnswerKeepsTheVendorsLine(t *testing.T) {
	t.Setenv("KIMI_INSTALL_DIR", "/usr/local")
	host := linuxHost
	host.Unwritable = func(target string) string {
		if strings.HasPrefix(target, "/usr/local") {
			return "/usr/local"
		}
		return ""
	}
	plan := shared.ScriptInstallPlanOn(InstallMethod, host)
	if plan.Kind != "unsupported" || plan.Reason != "requires_privileges" || len(plan.Steps) != 1 ||
		plan.Steps[0].Display != "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" || plan.Source != "https://github.com/MoonshotAI/kimi-code#install" {
		t.Fatalf("%+v", plan)
	}
}

// ─── update-sources.test.ts ────────────────────────────────────────────────

// releaseServer answers each path a fixed status and body (tests/fixtures/update-fixtures.ts).
type releaseServer struct {
	mu     sync.Mutex
	routes map[string][2]any
	base   string
}

func startReleaseServer(t *testing.T) *releaseServer {
	server := &releaseServer{routes: map[string][2]any{}}
	listener := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		server.mu.Lock()
		route, ok := server.routes[request.URL.Path]
		server.mu.Unlock()
		if !ok {
			route = [2]any{404, "not found"}
		}
		writer.WriteHeader(route[0].(int))
		_, _ = writer.Write([]byte(route[1].(string)))
	}))
	t.Cleanup(listener.Close)
	server.base = listener.URL
	return server
}

func (s *releaseServer) set(path string, status int, body string) {
	s.mu.Lock()
	s.routes[path] = [2]any{status, body}
	s.mu.Unlock()
}

func executableAt(command, version string) oar.AvailableInstallation {
	return oar.AvailableInstallation{Via: "executable", Command: command, Version: version}
}

func kimiHome(t *testing.T, dir, region string) string {
	home := filepath.Join(dir, "kimi-home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "region"), []byte(region+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestABundledInstallationHasNoUpdateCheck(t *testing.T) {
	server := startReleaseServer(t)
	dir := t.TempDir()
	check, err := UpdateCheck(UpdateSources{Mainland: server.base + "/x", Global: server.base + "/x", Home: func() string { return dir }})(context.Background(), oar.AvailableInstallation{Via: "bundled"}, oar.UpdateCheckOptions{})
	if err != nil || check.Kind != "unavailable" || check.Reason != "unsupported_installation" {
		t.Fatalf("%+v %v", check, err)
	}
}

func TestKimiFollowsItsRecordedRegionAndAFailedLookupIsReportedAsSuch(t *testing.T) {
	server := startReleaseServer(t)
	dir := t.TempDir()
	home := kimiHome(t, dir, "global")
	server.set("/kimi-global", 200, "2.1.1\n")
	server.set("/kimi-cn", 503, "busy")
	check := UpdateCheck(UpdateSources{Mainland: server.base + "/kimi-cn", Global: server.base + "/kimi-global", Home: func() string { return home }})
	global, err := check(context.Background(), executableAt(filepath.Join(dir, "kimi"), "2.1.0"), oar.UpdateCheckOptions{})
	if err != nil || global.Kind != "ok" || global.Latest != "2.1.1" {
		t.Fatalf("%+v %v", global, err)
	}
	kimiHome(t, dir, "mainland-cn")
	mainland, err := check(context.Background(), executableAt(filepath.Join(dir, "kimi"), "2.1.0"), oar.UpdateCheckOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, mainland, map[string]any{"kind": "unavailable", "reason": "lookup_failed", "detail": "HTTP 503", "source": server.base + "/kimi-cn"})
}

func TestKimiCountsOnlyANewerReleaseAsAnUpdateAsItsUpgradeDoes(t *testing.T) {
	server := startReleaseServer(t)
	dir := t.TempDir()
	home := kimiHome(t, dir, "global")
	server.set("/kimi-behind", 200, "2.0.9\n")
	check := UpdateCheck(UpdateSources{Mainland: server.base + "/kimi-behind", Global: server.base + "/kimi-behind", Home: func() string { return home }})
	ahead, err := check(context.Background(), executableAt(filepath.Join(dir, "kimi"), "2.1.0"), oar.UpdateCheckOptions{})
	if err != nil || ahead.Kind != "ok" || ahead.UpdateAvailable {
		t.Fatalf("%+v %v", ahead, err)
	}
}

// ─── update.test.ts ────────────────────────────────────────────────────────

func TestKimiBefore0430CannotUpgradeWithoutATerminal(t *testing.T) {
	result, err := Upgrade(context.Background(), executableAt(filepath.Join(t.TempDir(), "kimi"), "0.38.0"), oar.UpgradeOptions{})
	if err != nil || result.Kind != "unsupported" || result.Reason != "requires_terminal" {
		t.Fatalf("%+v %v", result, err)
	}
}

// fakeRuntime is tests/fixtures/update-fixtures.ts fakeRuntime: a CLI whose
// updater (fake-updater.mjs) is driven by a state file.
func fakeRuntime(t *testing.T, name string, state map[string]any) (command string, read func() map[string]any) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake runtime launcher is a POSIX shell script")
	}
	dir := t.TempDir()
	stateFile := filepath.Join(dir, name+".json")
	data, _ := json.Marshal(state)
	if err := os.WriteFile(stateFile, data, 0o644); err != nil {
		t.Fatal(err)
	}
	command = filepath.Join(dir, name)
	launcher := "#!/bin/sh\nexec \"" + nodePath(t) + "\" \"" + mustAbs(filepath.Join(fixturesDir, "fake-updater.mjs")) + "\" \"" + stateFile + "\" \"$@\"\n"
	if err := os.WriteFile(command, []byte(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	return command, func() map[string]any {
		var parsed map[string]any
		data, _ := os.ReadFile(stateFile)
		_ = json.Unmarshal(data, &parsed)
		return parsed
	}
}

func TestKimiFrom0430RunsItsUpdaterWithY(t *testing.T) {
	command, read := fakeRuntime(t, "kimi-new", map[string]any{"version": "0.43.0", "target": "2.1.1", "mode": "upgrade"})
	fixed := func(context.Context, oar.AvailableInstallation, oar.UpdateCheckOptions) (oar.UpdateCheck, error) {
		return oar.UpdateCheck{Kind: "ok", Installed: "0.43.0", Latest: "2.1.1", UpdateAvailable: true, Source: "fixture"}, nil
	}
	result, err := Upgrader(fixed)(context.Background(), executableAt(command, "0.43.0"), oar.UpgradeOptions{})
	if err != nil || result.Kind != "upgraded" || result.To != "2.1.1" {
		t.Fatalf("%+v %v", result, err)
	}
	jsonEqual(t, read()["updateArgs"], []string{"-y"})
}

// ─── additional-directories.test.ts ────────────────────────────────────────

func TestKimiRefusesADirectoryOverrideOnResumeBeforeStartingTheRuntimeOrLookingUpTheID(t *testing.T) {
	cwd := t.TempDir()
	_, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/does-not-exist"}, oar.SessionOptions{Cwd: cwd, Resume: "missing", AdditionalDirectories: []string{filepath.Join(cwd, "extra")}})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "additionalDirectories" || !strings.Contains(err.Error(), "no effect on resume") {
		t.Fatalf("%#v", err)
	}
}

// ─── inventory.test.ts, install-runtimes.test.ts ───────────────────────────

func TestUnavailableNativeSurfacesReturnUnsupportedWithoutStartingARuntime(t *testing.T) {
	runtime := Runtime()
	executable := oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/kimi"}
	skills, err := runtime.Skills(context.Background(), executable, oar.InventoryOptions{})
	if err != nil || skills.Kind != "unsupported" {
		t.Fatalf("%+v %v", skills, err)
	}
	commands, err := runtime.Commands(context.Background(), executable, oar.InventoryOptions{})
	if err != nil || commands.Kind != "unsupported" || commands.Code != "transport_unavailable" {
		t.Fatalf("%+v %v", commands, err)
	}
	if runtime.ID != "kimi" || runtime.Install == nil || runtime.InstallPlan == nil || runtime.InstallLines != nil {
		t.Fatalf("%+v", runtime)
	}
}
