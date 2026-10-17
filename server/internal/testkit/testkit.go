// Package testkit is only for tests. It imports nothing of the farm's, so every package's own tests can use it, protocol's too.
package testkit

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

// What failed, as JSON when it can be: the shapes are JSON, and nested values read better that way than as %#v.
func shown(v any) string {
	if body, err := json.Marshal(v); err == nil {
		return string(body)
	}
	return fmt.Sprintf("%#v", v)
}

func Eq(t testing.TB, got, want any, what ...any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s\n got  %s\n want %s", fmt.Sprint(what...), shown(got), shown(want))
	}
}

func Match(t testing.TB, got, pattern string, what ...any) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(got) {
		t.Fatalf("%s\n%q does not match %s", fmt.Sprint(what...), got, pattern)
	}
}

// How long a test waits for something that will happen, and how often it looks.
const (
	waitFor   = 10 * time.Second
	waitEvery = 10 * time.Millisecond
)

// The failure shows the last value check saw.
func Await[T any](t testing.TB, what string, check func() (T, bool)) T {
	t.Helper()
	for deadline := time.Now().Add(waitFor); ; time.Sleep(waitEvery) {
		v, ok := check()
		if ok {
			return v
		}
		if time.Now().After(deadline) {
			t.Fatalf("never: %s\n last %s", what, shown(v))
			return v
		}
	}
}

func Until(t testing.TB, what string, check func() bool) {
	t.Helper()
	for deadline := time.Now().Add(waitFor); !check(); time.Sleep(waitEvery) {
		if time.Now().After(deadline) {
			t.Fatalf("never: %s", what)
		}
	}
}

// For checking that something did not happen: a moment for anything already on its way to land.
func Settle() { time.Sleep(200 * time.Millisecond) }

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
