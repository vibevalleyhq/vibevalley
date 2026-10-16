package acp_test

// The real runtime profiles over the shared session: ported from
// tests/acp/acp-launch-args.test.ts, tests/acp/acp-missing-resume.test.ts
// and tests/acp/acp-session-token-totals.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/runtimes/antigravity"
	"vibevalley/pkg/smith/runtimes/grok"
	"vibevalley/pkg/smith/runtimes/kimi"
	"vibevalley/pkg/smith/runtimes/opencode"
)

// ─── acp-launch-args.test.ts ───────────────────────────────────────────────

func TestLaunchArgsGoAfterTheSubcommandAndGroksBeforeStdio(t *testing.T) {
	launchArgs := []string{"--flag", "value"}
	options := oar.SessionOptions{Cwd: "/work", LaunchArgs: launchArgs}
	equalStrings(t, acp.LaunchArgs(kimi.Profile, options), []string{"acp", "--flag", "value"})
	equalStrings(t, acp.LaunchArgs(opencode.Profile, options), []string{"acp", "--flag", "value"})
	equalStrings(t, acp.LaunchArgs(grok.Profile, options), []string{"agent", "--always-approve", "--no-leader", "--flag", "value", "stdio"})
	args := acp.LaunchArgs(antigravity.Profile, options)
	equalStrings(t, args[len(args)-2:], launchArgs)
}

func TestOmittedOrEmptyLaunchArgsLeaveEveryArgvAsItWas(t *testing.T) {
	for _, profile := range []acp.Profile{kimi.Profile, opencode.Profile, grok.Profile} {
		plain := acp.LaunchArgs(profile, oar.SessionOptions{Cwd: "/work"})
		equalStrings(t, acp.LaunchArgs(profile, oar.SessionOptions{Cwd: "/work", LaunchArgs: []string{}}), plain)
	}
}

// Node's spawn error carries the whole argv in `spawnargs`; a host that logs
// the rejection must not print the launch arguments (Lookout, #251).
func TestARuntimeThatCannotStartRejectsWithNoLaunchArgumentInTheError(t *testing.T) {
	secret := "LAUNCH-SECRET-123"
	_, err := kimi.Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/oar-runtime"}, oar.SessionOptions{Cwd: os.TempDir(), LaunchArgs: []string{"--token=" + secret}})
	if err == nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("want ENOENT, got %v", err)
	}
	if text := fmt.Sprintf("%v %+v %#v", err, err, err); strings.Contains(text, secret) {
		t.Fatal(text)
	}
}

// TS: Node refuses the argument before spawning (ERR_INVALID_ARG_VALUE).
func TestAnArgumentThatCannotBePassedIsNotQuotedInTheErrorEither(t *testing.T) {
	secret := "LAUNCH-SECRET-456"
	_, err := kimi.Session(context.Background(), installation(t), oar.SessionOptions{Cwd: os.TempDir(), LaunchArgs: []string{"--token=" + secret + "\x00x"}})
	if err == nil {
		t.Fatal("a NUL byte reached the runtime")
	}
	if text := fmt.Sprintf("%v %+v %#v", err, err, err); strings.Contains(text, secret) {
		t.Fatal(text)
	}
}

// ─── acp-missing-resume.test.ts ────────────────────────────────────────────

var missingResumeFixture = mustAbs(filepath.Join(fixturesDir, "fake-acp-missing-resume.mjs"))

func missingResumeErrors(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixturesDir, "missing-resume-errors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

var missingProfiles = []struct {
	name    string
	profile acp.Profile
}{
	{"antigravity", antigravity.Profile},
	{"grok", grok.Profile},
	{"kimi", kimi.Profile},
	{"opencode", opencode.Profile},
	{"opencodeV2", opencode.V2Profile},
}

func profileNamed(name string) acp.Profile {
	for _, entry := range missingProfiles {
		if entry.name == name {
			return entry.profile
		}
	}
	panic(name)
}

// openMissing opens profile against the missing-resume fixture with scenario; resume "" opens a new session.
func openMissing(t *testing.T, profile acp.Profile, scenario any, resume string, env map[string]*string) (oar.Session, error) {
	t.Helper()
	profile.Args = acp.StaticArgs(missingResumeFixture)
	encoded, err := json.Marshal(scenario)
	if err != nil {
		t.Fatal(err)
	}
	if env == nil {
		env = map[string]*string{}
	}
	env["FAKE_RESUME_CASE"] = oar.String(string(encoded))
	cwd, _ := os.Getwd()
	session, err := acp.Session(profile)(testContext(t), installation(t), oar.SessionOptions{Cwd: cwd, Resume: resume, Env: env})
	if err == nil {
		t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	}
	return session, err
}

var unlisted = map[string]any{"result": map[string]any{"sessions": []any{}}}

func notFound(err error) *oar.SessionNotFoundError {
	var target *oar.SessionNotFoundError
	if errors.As(err, &target) {
		return target
	}
	return nil
}

func TestEachRuntimeMapsItsRecordedMissingResumeError(t *testing.T) {
	errorsByRuntime := missingResumeErrors(t)
	for _, entry := range missingProfiles {
		t.Run(entry.name, func(t *testing.T) {
			native := errorsByRuntime[entry.name]
			_, err := openMissing(t, entry.profile, map[string]any{"error": native, "pages": []any{unlisted}}, "missing-session", nil)
			missing := notFound(err)
			if missing == nil || missing.SessionID != "missing-session" || missing.Method != "session/resume" {
				t.Fatalf("%#v", err)
			}
			jsonEqual(t, missing.Native, native)
		})
	}
}

func TestAntigravityUsesTheSameStructuralSignalOnSessionLoad(t *testing.T) {
	native := missingResumeErrors(t)["antigravity"]
	_, err := openMissing(t, antigravity.Profile, map[string]any{"error": native, "capability": "load", "errorMethod": "session/load"}, "missing-session", nil)
	missing := notFound(err)
	if missing == nil || missing.Method != "session/load" {
		t.Fatalf("%#v", err)
	}
	jsonEqual(t, missing.Native, native)
}

func TestNoRuntimeClassifiesAnInitializeOrNewSessionErrorAsAMissingResume(t *testing.T) {
	errorsByRuntime := missingResumeErrors(t)
	for _, entry := range missingProfiles {
		for _, errorMethod := range []string{"initialize", "session/new"} {
			t.Run(entry.name+" "+errorMethod, func(t *testing.T) {
				_, err := openMissing(t, entry.profile, map[string]any{"error": errorsByRuntime[entry.name], "errorMethod": errorMethod}, "", nil)
				if err == nil || notFound(err) != nil {
					t.Fatalf("%#v", err)
				}
			})
		}
	}
}

var listProfiles = []string{"kimi", "opencode", "opencodeV2"}

func TestAListedIDKeepsAGenericNativeResumeFailureEvenOnALaterPage(t *testing.T) {
	native := missingResumeErrors(t)["opencode"]
	cwd, _ := os.Getwd()
	listed := map[string]any{"result": map[string]any{"sessions": []any{map[string]any{"sessionId": "missing-session", "cwd": cwd}}}}
	for _, name := range listProfiles {
		t.Run(name, func(t *testing.T) {
			_, err := openMissing(t, profileNamed(name), map[string]any{"error": native, "pages": []any{map[string]any{"result": map[string]any{"sessions": []any{}, "nextCursor": "next"}}, listed}}, "missing-session", nil)
			if err == nil || notFound(err) != nil {
				t.Fatalf("%#v", err)
			}
			assertCause(t, err, "session/resume", native)
		})
	}
}

// assertCause: the open error keeps the native failure of method as its cause (TS `cause: {method, native}`).
func assertCause(t *testing.T, err error, method string, native json.RawMessage) {
	t.Helper()
	var cause *acp.NativeCause
	if !errors.As(err, &cause) {
		t.Fatalf("no native cause in %#v", err)
	}
	if cause.Method != method {
		t.Fatalf("cause method %q, want %q", cause.Method, method)
	}
	jsonEqual(t, cause.Native, native)
}

func TestCompletePaginationWithNoMatchProvesAbsenceOnlyWhenResumeFails(t *testing.T) {
	native := missingResumeErrors(t)["opencode"]
	for _, name := range listProfiles {
		t.Run(name, func(t *testing.T) {
			scenario := map[string]any{"error": native, "pages": []any{map[string]any{"result": map[string]any{"sessions": []any{}, "nextCursor": "next"}}, unlisted}}
			if _, err := openMissing(t, profileNamed(name), scenario, "missing-session", nil); notFound(err) == nil {
				t.Fatalf("%#v", err)
			}
			scenario["succeed"] = true
			session, err := openMissing(t, profileNamed(name), scenario, "missing-session", nil)
			if err != nil || session.ID() != "missing-session" {
				t.Fatalf("%v %v", session, err)
			}
		})
	}
}

func TestARealIDInAnotherCwdIsStillAnUnsupportedOptionError(t *testing.T) {
	native := missingResumeErrors(t)["opencode"]
	cwd, _ := os.Getwd()
	for _, name := range listProfiles {
		t.Run(name, func(t *testing.T) {
			_, err := openMissing(t, profileNamed(name), map[string]any{"error": native, "pages": []any{map[string]any{"result": map[string]any{"sessions": []any{map[string]any{"sessionId": "missing-session", "cwd": cwd + "/other"}}}}}}, "missing-session", nil)
			var unsupported *oar.UnsupportedOptionError
			if !errors.As(err, &unsupported) || unsupported.Option != "cwd" {
				t.Fatalf("%#v", err)
			}
		})
	}
}

func TestAnUnavailableIncompleteOrMalformedListNeverProvesAbsence(t *testing.T) {
	native := missingResumeErrors(t)["opencode"]
	for index, scenario := range []map[string]any{
		{"list": false},
		{"pages": []any{map[string]any{"result": map[string]any{}}}},
		{"pages": []any{map[string]any{"result": map[string]any{"sessions": []any{nil}}}}},
		{"pages": []any{map[string]any{"result": map[string]any{"sessions": []any{map[string]any{}}}}}},
		{"pages": []any{map[string]any{"result": map[string]any{"sessions": []any{}, "nextCursor": 7}}}},
		{"pages": []any{map[string]any{"result": map[string]any{"sessions": []any{}, "nextCursor": "repeated"}}}},
		{"pages": []any{map[string]any{"result": map[string]any{"sessions": []any{}, "nextCursor": "next"}}, map[string]any{"error": map[string]any{"code": -32603, "message": "list failed"}}}},
	} {
		scenario["error"] = native
		_, err := openMissing(t, opencode.Profile, scenario, "missing-session", nil)
		if err == nil || notFound(err) != nil {
			t.Fatalf("scenario %d: %#v", index, err)
		}
	}
}

func TestAnAuthenticationFailureKeepsItsClassificationDespiteAnEmptyList(t *testing.T) {
	for _, name := range listProfiles {
		t.Run(name, func(t *testing.T) {
			_, err := openMissing(t, profileNamed(name), map[string]any{"pages": []any{unlisted}, "error": map[string]any{"code": -32000, "message": "Authentication required"}}, "missing-session", nil)
			var failure *oar.RuntimeFailureError
			if !errors.As(err, &failure) || failure.Failure != "auth" {
				t.Fatalf("%#v", err)
			}
		})
	}
}

func TestOtherNativeFailuresAndProfilesWithoutARuleStayUnchanged(t *testing.T) {
	errorsByRuntime := missingResumeErrors(t)
	edit := func(raw json.RawMessage, key string, value any) json.RawMessage {
		var record map[string]any
		_ = json.Unmarshal(raw, &record)
		record[key] = value
		encoded, _ := json.Marshal(record)
		return encoded
	}
	for index, c := range []struct {
		profile acp.Profile
		native  json.RawMessage
	}{
		{antigravity.Profile, edit(errorsByRuntime["antigravity"], "code", -32603)},
		{grok.Profile, edit(errorsByRuntime["grok"], "data", map[string]any{"code": "FS_ACCESS_DENIED"})},
		{acp.Profile{Capabilities: acp.Capabilities{Attribution: "opaque"}}, errorsByRuntime["antigravity"]},
	} {
		_, err := openMissing(t, c.profile, map[string]any{"error": c.native, "pages": []any{unlisted}}, "missing-session", nil)
		if err == nil || notFound(err) != nil {
			t.Fatalf("case %d: %#v", index, err)
		}
		assertCause(t, err, "session/resume", c.native)
	}
}

func TestAMappedErrorRemainsTypedAfterCredentialRedactionWithAJSONSafeNativeCause(t *testing.T) {
	secret := "resume-missing-secret-sentinel"
	var native map[string]any
	_ = json.Unmarshal(missingResumeErrors(t)["grok"], &native)
	data := native["data"].(map[string]any)
	data["detail"] = secret
	_, err := openMissing(t, grok.Profile, map[string]any{"error": native}, "missing-session", map[string]*string{"API_KEY": oar.String(secret)})
	missing := notFound(err)
	if missing == nil {
		t.Fatalf("%#v", err)
	}
	if text := fmt.Sprintf("%v %+v %#v %s", err, err, err, missing.Native); strings.Contains(text, secret) {
		t.Fatal(text)
	}
	encoded, _ := json.Marshal(map[string]any{"method": missing.Method, "native": missing.Native})
	var persisted map[string]any
	if err := json.Unmarshal(encoded, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted["method"] != "session/resume" {
		t.Fatal(persisted)
	}
	jsonEqual(t, persisted["native"].(map[string]any)["data"].(map[string]any)["code"], "FS_NOT_FOUND")
	jsonEqual(t, persisted["native"].(map[string]any)["data"].(map[string]any)["detail"], "[redacted]")
}

// ─── acp-session-token-totals.test.ts ──────────────────────────────────────

// #161: kimi, opencode and antigravity report no token totals on their ACP
// surface (docs/runtimes/<id>.md), so Usage() stays null over turns and no
// cacheRead / cacheWrite can appear. Each real profile runs against the
// fixture mode that replays its runtime, only the launch line swapped.
func TestNonReportingRuntimesReportNoTokenTotalsOverTwoTurns(t *testing.T) {
	for _, c := range []struct {
		name    string
		profile acp.Profile
		mode    string
	}{
		{"kimi", kimi.Profile, "usage-after-response"},
		{"opencode", opencode.Profile, "opencode"},
		{"antigravity", antigravity.Profile, "antigravity"},
	} {
		t.Run(c.name, func(t *testing.T) {
			profile := c.profile
			profile.Args = acp.StaticArgs(fixture, c.mode)
			session := startSession(t, profile, startOptions{})
			for _, input := range []string{"one", "two"} {
				if run := promptAndWait(t, session, input, observe.PromptRunOptions{}); run.Kind != "ended" {
					t.Fatalf("%s: %s", input, run.Kind)
				}
			}
			jsonEqual(t, session.Usage().Value, map[string]any{"total": nil})
			for _, frame := range frames(session) {
				for _, event := range frame.Events {
					if usage, ok := event.(oar.Usage); ok && usage.Usage.Tokens != nil {
						t.Fatalf("a usage event carries tokens: %+v", usage)
					}
				}
			}
		})
	}
}
