package shared

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

func nodeVersion(t *testing.T, node string) string {
	t.Helper()
	out, err := exec.Command(node, "--version").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func probe(t *testing.T, installation oar.InstallationProbe) oar.InstallationSnapshot {
	t.Helper()
	snapshot, err := installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func available(command, version string, shadowed ...string) oar.InstallationSnapshot {
	installation := oar.AvailableInstallation{Via: "executable", Command: command, Version: version}
	if len(shadowed) > 0 {
		installation.Shadowed = shadowed
	}
	return oar.Available(installation)
}

func TestExecutableInstallationOnPath(t *testing.T) {
	node := nodeOrSkip(t)
	version := nodeVersion(t, node)
	t.Setenv("OAR_FIXTURE_BIN", "")
	onPath := LocateOnPath("node")
	if onPath == nil {
		t.Fatal("node is not on PATH")
	}
	// Just the folder of the node that runs, so the machine's other node copies stay out.
	t.Setenv("PATH", filepath.Dir(onPath.Command))
	if got := probe(t, ExecutableInstallation("OAR_FIXTURE_BIN", "node", nil, nil, ExecutableInstallationOptions{})); !reflect.DeepEqual(got, available(onPath.Command, version)) {
		t.Fatalf("got %+v", got)
	}
	if got := probe(t, ExecutableInstallation("OAR_FIXTURE_BIN", "oar-fixture-missing", nil, nil, ExecutableInstallationOptions{})); got.Kind != "not_found" {
		t.Fatalf("got %+v", got)
	}
	// Readiness gates each candidate.
	if got := probe(t, ExecutableInstallation("OAR_FIXTURE_BIN", "node", nil, []string{"--version"}, ExecutableInstallationOptions{})); !reflect.DeepEqual(got, available(onPath.Command, version)) {
		t.Fatalf("ready = %+v", got)
	}
	// Node rejects the app-server-style subcommand, so the probe is unsupported.
	unsupported := probe(t, ExecutableInstallation("OAR_FIXTURE_BIN", "node", nil, []string{"oar-fixture-subcommand", "--help"}, ExecutableInstallationOptions{}))
	jsonEqual(t, unsupported, `{"kind":"unsupported","reason":"oar-fixture-subcommand --help failed"}`)
}

func TestExecutableInstallationFallbacks(t *testing.T) {
	node := nodeOrSkip(t)
	version := nodeVersion(t, node)
	t.Setenv("OAR_FIXTURE_BIN", "")
	// A missing fallback path contributes no candidate.
	got := probe(t, ExecutableInstallation("OAR_FIXTURE_BIN", "oar-fixture-missing", Fallbacks("/nonexistent/oar-fixture", node), nil, ExecutableInstallationOptions{}))
	if !reflect.DeepEqual(got, available(node, version)) {
		t.Fatalf("got %+v", got)
	}
	// Fallback factories are evaluated at probe time.
	fallback := "/nonexistent/oar-fixture"
	installation := ExecutableInstallation("OAR_FIXTURE_BIN", "oar-fixture-missing", func() []string { return []string{fallback} }, nil, ExecutableInstallationOptions{})
	fallback = node
	if got := probe(t, installation); !reflect.DeepEqual(got, available(node, version)) {
		t.Fatalf("got %+v", got)
	}
}

func TestPinnedEnvVarIsExclusive(t *testing.T) {
	node := nodeOrSkip(t)
	version := nodeVersion(t, node)
	evaluated := false
	installation := ExecutableInstallation("OAR_FIXTURE_BIN", "node", func() []string { evaluated = true; return nil }, nil, ExecutableInstallationOptions{})
	t.Setenv("OAR_FIXTURE_BIN", "/nonexistent/oar-fixture")
	if got := probe(t, installation); got.Kind != "not_found" {
		t.Fatalf("pinned missing = %+v", got)
	}
	t.Setenv("OAR_FIXTURE_BIN", node)
	if got := probe(t, installation); !reflect.DeepEqual(got, available(node, version)) {
		t.Fatalf("pinned = %+v", got)
	}
	if evaluated {
		t.Fatal("a pinned env var evaluated the fallbacks")
	}
}

// installation-diagnostics.test.ts and executable-diagnostics.test.ts, with
// real executables in place of the mocked runner: a readiness run that never
// ran to an exit code of its own fails the probe with the native reason.
func TestReadinessFailuresAreErrors(t *testing.T) {
	posixOnly(t)
	dir := t.TempDir()
	inert := filepath.Join(dir, "inert")
	if err := os.WriteFile(inert, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OAR_DIAGNOSTIC_FIXTURE_BIN", "")
	_, err := ExecutableInstallation("OAR_DIAGNOSTIC_FIXTURE_BIN", inert, nil, []string{"--ready"}, ExecutableInstallationOptions{})(context.Background())
	if err == nil || !strings.HasPrefix(err.Error(), "Failed to run "+inert+" --ready: exit code unavailable; signal none; spawn "+inert) {
		t.Fatalf("err = %v", err)
	}
	t.Setenv("OAR_KILL_GRACE_MS", "100")
	slow := script(t, dir, "slow", "sleep 10\n")
	_, err = ExecutableInstallation("OAR_DIAGNOSTIC_FIXTURE_BIN", slow, nil, []string{"--ready"}, ExecutableInstallationOptions{ReadinessTimeout: 100 * time.Millisecond})(context.Background())
	if err == nil || !strings.Contains(err.Error(), "timeout after 100 ms") {
		t.Fatalf("an installation timeout exposes its cause without extending the deadline: %v", err)
	}
}

// installation-shadowed.test.ts

const shadowName = "oar-shadow-fixture"
const shadowEnv = "OAR_SHADOW_FIXTURE_BIN"

func copyIn(t *testing.T, dir string) string {
	t.Helper()
	return script(t, dir, shadowName, "echo 'fixture 1.0.0'\n")
}

func folders(t *testing.T, names ...string) []string {
	t.Helper()
	base := t.TempDir()
	var dirs []string
	for _, name := range names {
		dir := filepath.Join(base, name)
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		dirs = append(dirs, dir)
	}
	return dirs
}

// onPath puts dirs ahead of the machine's PATH, which has no fixture copy, with no override.
func onPath(t *testing.T, dirs ...string) {
	t.Helper()
	t.Setenv("PATH", strings.Join(append(dirs, os.Getenv("PATH")), string(os.PathListSeparator)))
	t.Setenv(shadowEnv, "")
}

func located(command string, shadowed ...string) *LocatedExecutable {
	if shadowed == nil {
		shadowed = []string{}
	}
	return &LocatedExecutable{Command: command, Shadowed: shadowed}
}

func TestShadowedCopiesInPathOrder(t *testing.T) {
	posixOnly(t)
	original := os.Getenv("PATH")
	dirs := folders(t, "a", "b", "c")
	a, b, c := dirs[0], dirs[1], dirs[2]
	copyA, copyB, copyC := copyIn(t, a), copyIn(t, b), copyIn(t, c)
	onPath(t, a, b, a, c, b)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyA, copyB, copyC)) {
		t.Fatalf("got %+v", got)
	}
	t.Setenv("PATH", original)
	onPath(t, c, a, c)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyC, copyA)) {
		t.Fatalf("got %+v", got)
	}
	t.Setenv("PATH", original)
	onPath(t, a)
	if got := LocateOnPath("oar-shadow-missing"); got != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestFoldersResolvingToOneFolderHoldOneCopy(t *testing.T) {
	posixOnly(t)
	original := os.Getenv("PATH")
	dirs := folders(t, "real", "other", "first")
	real, other, first := dirs[0], dirs[1], dirs[2]
	link := filepath.Join(filepath.Dir(real), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	copyReal, copyOther, copyFirst := copyIn(t, real), copyIn(t, other), copyIn(t, first)
	copyLink := filepath.Join(link, filepath.Base(copyReal))
	onPath(t, link, real, other)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyLink, copyOther)) {
		t.Fatalf("got %+v", got)
	}
	t.Setenv("PATH", original)
	onPath(t, first, real, link)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyFirst, copyReal)) {
		t.Fatalf("got %+v", got)
	}
}

func TestSymlinkToTheRunningCopyIsTheRunningCopy(t *testing.T) {
	posixOnly(t)
	original := os.Getenv("PATH")
	dirs := folders(t, "a", "b", "alias")
	a, b, alias := dirs[0], dirs[1], dirs[2]
	copyA, copyB := copyIn(t, a), copyIn(t, b)
	copyAlias := filepath.Join(alias, filepath.Base(copyA))
	if err := os.Symlink(copyA, copyAlias); err != nil {
		t.Fatal(err)
	}
	onPath(t, alias, a, b)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyAlias, copyB)) {
		t.Fatalf("got %+v", got)
	}
	t.Setenv("PATH", original)
	onPath(t, a, alias)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyA)) {
		t.Fatalf("got %+v", got)
	}
}

func TestFilesThatCannotRunAreNotCopies(t *testing.T) {
	posixOnly(t)
	dirs := folders(t, "folder-named", "inert", "a", "b")
	folderNamed, inert, a, b := dirs[0], dirs[1], dirs[2], dirs[3]
	if err := os.Mkdir(filepath.Join(folderNamed, shadowName), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(inert, shadowName), []byte("#!/bin/sh\necho 'fixture 1.0.0'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	copyA, copyB := copyIn(t, a), copyIn(t, b)
	onPath(t, folderNamed, inert, a, inert, b, folderNamed)
	if got := LocateOnPath(shadowName); !reflect.DeepEqual(got, located(copyA, copyB)) {
		t.Fatalf("got %+v", got)
	}
}

func TestLaunchersBesideEachOtherAreOneCopy(t *testing.T) {
	// npm writes codex.cmd and codex.ps1 together; with .PS1 in PATHEXT both match.
	dirs := folders(t, "a", "b")
	a, b := dirs[0], dirs[1]
	aCmd, aPs1, bCmd, bPs1 := filepath.Join(a, shadowName+".CMD"), filepath.Join(a, shadowName+".PS1"), filepath.Join(b, shadowName+".CMD"), filepath.Join(b, shadowName+".PS1")
	for _, launcher := range []string{aCmd, aPs1, bCmd, bPs1} {
		if err := os.WriteFile(launcher, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got := ShadowedCopies([]string{aCmd, aPs1, bCmd, bPs1}); !reflect.DeepEqual(got, []string{bCmd}) {
		t.Fatalf("got %v", got)
	}
	if got := ShadowedCopies([]string{aCmd, aPs1}); !reflect.DeepEqual(got, []string{}) {
		t.Fatalf("got %v", got)
	}
}

func TestInstallationOnPathReportsShadowedCopies(t *testing.T) {
	posixOnly(t)
	original := os.Getenv("PATH")
	dirs := folders(t, "a", "b")
	a, b := dirs[0], dirs[1]
	copyA, copyB := copyIn(t, a), copyIn(t, b)
	installation := ExecutableInstallation(shadowEnv, shadowName, nil, nil, ExecutableInstallationOptions{})
	onPath(t, a, b)
	if got := probe(t, installation); !reflect.DeepEqual(got, available(copyA, "fixture 1.0.0", copyB)) {
		t.Fatalf("got %+v", got)
	}
	jsonEqual(t, probe(t, installation), `{"kind":"available","via":"executable","command":`+jsonText(copyA)+`,"version":"fixture 1.0.0","shadowed":[`+jsonText(copyB)+`]}`)
	// A bare-name fallback (morph's mistermorph) is a PATH lookup too.
	if got := probe(t, ExecutableInstallation(shadowEnv, "oar-shadow-missing", Fallbacks(shadowName), nil, ExecutableInstallationOptions{})); !reflect.DeepEqual(got, available(copyA, "fixture 1.0.0", copyB)) {
		t.Fatalf("got %+v", got)
	}
	// One copy on PATH: no field.
	t.Setenv("PATH", original)
	onPath(t, a)
	jsonEqual(t, probe(t, installation), `{"kind":"available","via":"executable","command":`+jsonText(copyA)+`,"version":"fixture 1.0.0"}`)
}

func TestOverrideOrFallbackOutsidePathReportsNoShadowedCopies(t *testing.T) {
	posixOnly(t)
	dirs := folders(t, "a", "b", "outside")
	a, b, outside := dirs[0], dirs[1], dirs[2]
	copyA, copyOutside := copyIn(t, a), copyIn(t, outside)
	copyIn(t, b)
	installation := ExecutableInstallation(shadowEnv, shadowName, nil, nil, ExecutableInstallationOptions{})
	onPath(t, a, b)
	// An override names the executable, as a path or a bare name.
	t.Setenv(shadowEnv, copyA)
	if got := probe(t, installation); !reflect.DeepEqual(got, available(copyA, "fixture 1.0.0")) {
		t.Fatalf("got %+v", got)
	}
	t.Setenv(shadowEnv, shadowName)
	if got := probe(t, installation); !reflect.DeepEqual(got, available(copyA, "fixture 1.0.0")) {
		t.Fatalf("got %+v", got)
	}
	// A fallback outside PATH (codex's macOS app bundle) is not a PATH lookup.
	t.Setenv(shadowEnv, "")
	if got := probe(t, ExecutableInstallation(shadowEnv, "oar-shadow-missing", Fallbacks(copyOutside), nil, ExecutableInstallationOptions{})); !reflect.DeepEqual(got, available(copyOutside, "fixture 1.0.0")) {
		t.Fatalf("got %+v", got)
	}
}
