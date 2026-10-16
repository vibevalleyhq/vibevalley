package acp_test

// Ported from tests/acp/acp-open-errors.test.ts, acp-additional-directories.test.ts
// and acp-resume-cwd.test.ts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/oar"
)

func TestOpenErrorsKeepCodeDataAndMethodWhileRedactingTheCauseChain(t *testing.T) {
	const secret = "acp-open-error-env-sentinel"
	start := acp.Session(acp.Profile{
		Args:         acp.StaticArgs(mustAbs(filepath.Join(fixturesDir, "fake-acp-open-error.mjs"))),
		Capabilities: acp.Capabilities{Attribution: "nested"},
		ConfigureSession: func(configure acp.ConfigureContext) error {
			_, err := configure.Request("session/set_mode", map[string]any{"sessionId": configure.SessionID, "modeId": "yolo"})
			return err
		},
	})
	for _, method := range []string{"initialize", "session/new", "session/resume", "session/set_mode"} {
		t.Run(method, func(t *testing.T) {
			cwd, _ := os.Getwd()
			options := oar.SessionOptions{
				Cwd:        cwd,
				MCPServers: []oar.McpServer{{Name: "echo", Command: "echo", Env: map[string]string{"TOKEN": secret}}},
				Env: map[string]*string{
					"FAKE_ERROR_METHOD": oar.String(method),
					"FAKE_ERROR":        oar.String(fmt.Sprintf(`{"code":-32000,"message":"denied %s","data":{"nested":[{%q:%q}],"status":401}}`, secret, secret, secret)),
				},
			}
			if method == "session/resume" {
				options.Resume = "saved-session"
			}
			_, failure := start(testContext(t), installation(t), options)
			if failure == nil {
				t.Fatal("the open succeeded")
			}
			mapped := method != "session/set_mode"
			var runtimeFailure *oar.RuntimeFailureError
			if errors.As(failure, &runtimeFailure) != mapped {
				t.Fatalf("mapped=%v: %#v", mapped, failure)
			}
			if mapped && runtimeFailure.Failure != oar.FailureAuth {
				t.Fatal(runtimeFailure.Failure)
			}
			var cause *acp.NativeCause
			if !errors.As(failure, &cause) {
				t.Fatalf("no native cause: %#v", failure)
			}
			jsonEqual(t, cause, json.RawMessage(`{"method":"`+method+`","native":{"code":-32000,"message":"denied [redacted]","data":{"nested":[{"[redacted]":"[redacted]"}],"status":401}}}`))
			causeJSON, _ := json.Marshal(cause)
			for _, output := range []string{fmt.Sprintf("%#v", failure), fmt.Sprintf("%+v", failure), failure.Error(), string(causeJSON)} {
				if strings.Contains(output, secret) {
					t.Fatalf("the secret leaked: %s", output)
				}
			}
		})
	}
}

func TestDirectoryRootsGoOutOnlyAfterCapabilityAdvertisement(t *testing.T) {
	for _, resume := range []string{"", "previous"} {
		t.Run("resume="+resume, func(t *testing.T) {
			cwd := t.TempDir()
			log := filepath.Join(cwd, "opens.jsonl")
			options := oar.SessionOptions{Cwd: cwd, AdditionalDirectories: []string{"../extra directory"}, Resume: resume, Env: map[string]*string{"FAKE_ACP_DIRECTORIES_LOG": oar.String(log)}}
			start := acp.Session(baseProfile())
			_, err := start(testContext(t), installation(t), options)
			var unsupported *oar.UnsupportedOptionError
			if !errors.As(err, &unsupported) || unsupported.Option != "additionalDirectories" {
				t.Fatalf("want an additionalDirectories refusal, got %v", err)
			}
			if _, err := os.Stat(log); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("the agent saw an open: %v", err)
			}
			options.Env["FAKE_ACP_DIRECTORIES"] = oar.String("1")
			session, err := start(testContext(t), installation(t), options)
			if err != nil {
				t.Fatal(err)
			}
			if err := session.Dispose(testContext(t)); err != nil {
				t.Fatal(err)
			}
			text, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			method := "session/new"
			if resume != "" {
				method = "session/resume"
			}
			jsonEqual(t, json.RawMessage(strings.TrimSpace(string(text))), map[string]any{"method": method, "additionalDirectories": []string{filepath.Join(filepath.Dir(cwd), "extra directory")}})
		})
	}
}

func scratch(t *testing.T) string {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestResumeInAnotherDirectoryIsRefusedNamingBoth(t *testing.T) {
	own, other := scratch(t), scratch(t)
	listed := profileWith(func(profile *acp.Profile) {
		profile.Args = acp.StaticArgs(fixture, "listed")
		profile.ResumeKeepsSessionCwd = true
	})
	env := map[string]*string{"FAKE_ACP_SESSION_CWD": oar.String(own)}
	_, err := acp.Session(listed)(testContext(t), installation(t), oar.SessionOptions{Cwd: other, Resume: "fake-session", Env: env})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "cwd" {
		t.Fatalf("want a cwd refusal, got %v", err)
	}
	if want := "session fake-session lives in " + own + " and this runtime resumes it only there; the resume names " + other; unsupported.Message != want {
		t.Fatalf("message %q", unsupported.Message)
	}
	session, err := acp.Session(listed)(testContext(t), installation(t), oar.SessionOptions{Cwd: own, Resume: "fake-session", Env: env})
	if err != nil {
		t.Fatal(err)
	}
	if session.ID() != "fake-session" {
		t.Fatal(session.ID())
	}
	_ = session.Dispose(testContext(t))
	// Without the flag the resume is not checked.
	unchecked, err := acp.Session(profileWith(func(profile *acp.Profile) { profile.Args = acp.StaticArgs(fixture, "listed") }))(testContext(t), installation(t), oar.SessionOptions{Cwd: other, Resume: "fake-session", Env: env})
	if err != nil {
		t.Fatal(err)
	}
	if unchecked.ID() != "fake-session" {
		t.Fatal(unchecked.ID())
	}
	_ = unchecked.Dispose(testContext(t))
}
