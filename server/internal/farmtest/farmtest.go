// Package farmtest is only for tests.
package farmtest

import (
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/protocol"
)

func Eq(t testing.TB, got, want any, what string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s:\n got  %#v\n want %#v", what, got, want)
	}
}

func Match(t testing.TB, got, pattern, what string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(got) {
		t.Fatalf("%s: %q does not match %s", what, got, pattern)
	}
}

func Ptr[T any](v T) *T { return &v }

func Until(t testing.TB, what string, check func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !check(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("never: %s", what)
		}
	}
}

func Await[T any](t testing.TB, what string, check func() (T, bool)) T {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if v, ok := check(); ok {
			return v
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("never: %s", what)
	var zero T
	return zero
}

func Git(t testing.TB, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// The repository's own user is me@vibevalley.test: mine commits by me, theirs by someone else.
func Repo(t testing.TB, dir string, mine, theirs int) {
	t.Helper()
	os.MkdirAll(dir, 0o755)
	Git(t, dir, "init", "-q", "-b", "main")
	Git(t, dir, "config", "user.email", "me@vibevalley.test")
	Git(t, dir, "config", "user.name", "Me")
	for i := range mine {
		Git(t, dir, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("mine %d", i))
	}
	for i := range theirs {
		Git(t, dir, "commit", "-q", "--allow-empty", "-m", fmt.Sprintf("theirs %d", i), "--author", "Colleague <colleague@vibevalley.test>")
	}
}

func PiInfo() protocol.RuntimeInfo {
	return protocol.RuntimeInfo{
		ID:           "pi",
		Installation: protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaBundled, Command: "pi"}},
		Settings:     protocol.RuntimeSettings{Enabled: true, Env: map[string]string{}},
	}
}

// A scripted runtime has no models, so no effort levels: smith would refuse 'medium'.
func Lab(t testing.TB) protocol.AgentProfile {
	for _, a := range protocol.SeedAgents() {
		if a.ID == "lab" {
			a.Effort = ""
			return a
		}
	}
	t.Fatal("the seeds have the pi agent")
	return protocol.AgentProfile{}
}
