package claude

import (
	"context"
	"math"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude-account-usage-reader.test.ts.

var usageInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude"}

var helpWithSafeMode = executable.Result{OK: true, Stdout: "  --safe-mode   Start with all customizations disabled\n", ExitCode: intPtr(0)}

var availableUsage = map[string]any{
	"subscription_type": "max", "rate_limits_available": true,
	"rate_limits": map[string]any{"five_hour": map[string]any{"utilization": 25, "resets_at": "2026-09-16T12:00:00+08:00"}},
}

// helpRunner records --help runs and answers from results in order (the last again).
type helpRunner struct {
	mu      sync.Mutex
	results []func() executable.Result
	calls   []executable.RunOptions
}

func useHelp(t *testing.T, results ...func() executable.Result) *helpRunner {
	t.Helper()
	// Each test starts with no help probe cached (TS: one module per test file, read in order).
	safeModeMu.Lock()
	safeModeSupport = map[string]bool{}
	safeModeMu.Unlock()
	runner := &helpRunner{results: results}
	useRunExecutable(t, func(_ context.Context, _ string, _ []string, options executable.RunOptions) executable.Result {
		runner.mu.Lock()
		index := min(len(runner.calls), len(runner.results)-1)
		runner.calls = append(runner.calls, options)
		answer := runner.results[index]
		runner.mu.Unlock()
		return answer()
	})
	return runner
}

func (r *helpRunner) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func always(result executable.Result) func() executable.Result {
	return func() executable.Result { return result }
}

func controlOf(text string) (any, any) {
	request := jsonx.ParseRecord([]byte(strings.TrimSpace(text)))
	return request["request_id"], jsonx.AsRecord(request["request"])["subtype"]
}

func answerControl(fake *fakeProcess, id any, response any) {
	fake.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"request_id": id, "subtype": "success", "response": response}})
}

func serving(payload any) *fakeProcess {
	return newFakeProcess(func(text string, self *fakeProcess) {
		id, subtype := controlOf(text)
		if subtype == "initialize" {
			answerControl(self, id, map[string]any{"account": map[string]any{"email": "person@example.com"}})
			return
		}
		answerControl(self, id, payload)
	})
}

func usageCtx(t *testing.T) context.Context { return testContext(t) }

func TestNativeUsageUsesCorrelatedControlRequests(t *testing.T) {
	t.Setenv("CLAUDECODE", "nested-session")
	useHelp(t, always(helpWithSafeMode))
	fake := newFakeProcess(func(text string, self *fakeProcess) {
		id, subtype := controlOf(text)
		self.emit("not-json\n")
		self.emitJSON(map[string]any{"type": "system", "subtype": "init"})
		answerControl(self, "unrelated", map[string]any{"rate_limits_available": false})
		if subtype == "initialize" {
			answerControl(self, id, map[string]any{"account": map[string]any{"email": "person@example.com"}})
		} else {
			answerControl(self, id, availableUsage)
		}
	})
	spawner := useFakeSpawner(t, fake)
	snapshot, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"available","email":"person@example.com","plan":"max","rateLimited":false,
		"windows":[{"label":"Current session","usedRatio":0.25,"resetsAt":"2026-09-16T04:00:00.000Z","id":"five_hour","durationMs":18000000}]}`)
	var requests []any
	for _, record := range fake.writtenRecords() {
		requests = append(requests, record["request"])
	}
	assertJSON(t, requests, `[{"subtype":"initialize"},{"subtype":"get_usage","skip_behaviors":true}]`)
	if spawner.count() != 1 {
		t.Fatalf("spawned %d times", spawner.count())
	}
	call := spawner.call(0)
	if call.command != "claude" || !reflect.DeepEqual(call.args, []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--safe-mode"}) || !call.options.KillTree {
		t.Fatalf("spawn = %+v", call)
	}
	if _, set := envOf(call.options.Env, "CLAUDECODE"); set {
		t.Fatal("CLAUDECODE reached the usage process")
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

// A usage read must not run the user's SessionStart hooks or start their MCP
// servers; --safe-mode is what isolates it (verified live against CLI 2.1.283).
func TestCLIWithoutSafeModeIsUnsupportedAndNeverLaunched(t *testing.T) {
	useHelp(t, always(executable.Result{OK: true, Stdout: "  --verbose  Verbose output\n", ExitCode: intPtr(0)}))
	spawner := useFakeSpawner(t, newFakeProcess(nil))
	old := oar.AvailableInstallation{Via: "executable", Command: "claude-old", Version: "1.0.0"}
	snapshot, err := AccountUsage(usageCtx(t), old, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"unsupported","reason":"unsupported_installation"}`)
	if spawner.count() != 0 {
		t.Fatal("spawned")
	}
}

func TestFailedHelpProbeIsNotCachedAsUnsupported(t *testing.T) {
	runner := useHelp(t, always(executable.Result{OK: false, ExitCode: intPtr(2)}), always(helpWithSafeMode))
	flaky := oar.AvailableInstallation{Via: "executable", Command: "claude-flaky", Version: "2.1.283"}
	snapshot, err := AccountUsage(usageCtx(t), flaky, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"unsupported","reason":"unsupported_installation"}`)
	useFakeSpawner(t, serving(availableUsage))
	snapshot, err = AccountUsage(usageCtx(t), flaky, oar.AccountUsageReadOptions{})
	if err != nil || snapshot.Kind != "available" {
		t.Fatalf("snapshot = %+v %v", snapshot, err)
	}
	if runner.count() != 2 {
		t.Fatalf("help ran %d times", runner.count())
	}
}

// A timeout is an operational failure, which rejects (docs/spec/account-usage.md).
func TestHelpProbeThatTimedOutRejectsAndIsNotCached(t *testing.T) {
	timedOut := executable.Result{OK: false, Diagnostics: &executable.Diagnostics{Signal: "SIGTERM", Timeout: 2000 * time.Millisecond}}
	runner := useHelp(t, always(timedOut), always(helpWithSafeMode))
	spawner := useFakeSpawner(t, serving(availableUsage))
	slow := oar.AvailableInstallation{Via: "executable", Command: "claude-slow", Version: "2.1.291"}
	_, err := AccountUsage(usageCtx(t), slow, oar.AccountUsageReadOptions{Timeout: 2000 * time.Millisecond})
	if err == nil || !regexp.MustCompile(`claude-slow --help.*timeout after 2000 ms`).MatchString(err.Error()) {
		t.Fatalf("err = %v", err)
	}
	if runner.calls[0].Timeout > 2000*time.Millisecond {
		t.Fatalf("help timeout = %s", runner.calls[0].Timeout)
	}
	if spawner.count() != 0 {
		t.Fatal("spawned")
	}
	snapshot, err := AccountUsage(usageCtx(t), slow, oar.AccountUsageReadOptions{})
	if err != nil || snapshot.Kind != "available" {
		t.Fatalf("snapshot = %+v %v", snapshot, err)
	}
	if runner.count() != 2 {
		t.Fatalf("help ran %d times", runner.count())
	}
}

// timeoutMs bounds the whole read: the help probe and the query share it.
func TestUncachedHelpProbeAndQueryShareTheTimeout(t *testing.T) {
	useHelp(t, func() executable.Result {
		time.Sleep(1500 * time.Millisecond)
		return helpWithSafeMode
	})
	useFakeSpawner(t, newFakeProcess(nil))
	fresh := oar.AvailableInstallation{Via: "executable", Command: "claude-fresh", Version: "2.1.291"}
	started := time.Now()
	_, err := AccountUsage(usageCtx(t), fresh, oar.AccountUsageReadOptions{Timeout: 2000 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 2300*time.Millisecond {
		t.Fatalf("the read took %s", elapsed)
	}
}

func TestNativeUnavailableQuotaIsNotGuessedAsCredentials(t *testing.T) {
	useHelp(t, always(helpWithSafeMode))
	fake := serving(map[string]any{"subscription_type": nil, "rate_limits_available": false, "rate_limits": nil,
		"session": map[string]any{"total_cost_usd": 0, "model_usage": map[string]any{}}})
	useFakeSpawner(t, fake)
	snapshot, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"unsupported","reason":"quota_unavailable"}`)
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func rejectingUsage(nativeError string) *fakeProcess {
	return newFakeProcess(func(text string, self *fakeProcess) {
		id, subtype := controlOf(text)
		if subtype == "initialize" {
			answerControl(self, id, map[string]any{})
			return
		}
		self.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": id, "error": nativeError}})
	})
}

func TestNativeRejections(t *testing.T) {
	for _, tc := range []struct{ native, kind, reason string }{
		{"Unsupported control request subtype: get_usage", "unsupported", "endpoint_unavailable"},
		{"get_usage is not supported in this context (onGetUsage callback not registered)", "unsupported", "endpoint_unavailable"},
		{"Not logged in. Please run /login", "reauth_required", "not_authenticated"},
	} {
		t.Run(tc.native, func(t *testing.T) {
			useHelp(t, always(helpWithSafeMode))
			fake := rejectingUsage(tc.native)
			useFakeSpawner(t, fake)
			snapshot, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{})
			if err != nil {
				t.Fatal(err)
			}
			assertJSON(t, snapshot, `{"kind":"`+tc.kind+`","reason":"`+tc.reason+`"}`)
			if !fake.killed() {
				t.Fatal("not killed")
			}
		})
	}
}

func TestOperationalFailuresStayErrors(t *testing.T) {
	useHelp(t, always(helpWithSafeMode))
	fake := rejectingUsage("upstream unavailable")
	useFakeSpawner(t, fake)
	_, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{})
	if err == nil || !strings.Contains(err.Error(), "upstream unavailable") {
		t.Fatalf("err = %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestUsageTimeoutReleasesTheSubprocess(t *testing.T) {
	useHelp(t, always(helpWithSafeMode))
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	_, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{Timeout: 20 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err = %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestExitAfterInitializeCannotLeaveTheNextQueryWaiting(t *testing.T) {
	useHelp(t, always(helpWithSafeMode))
	fake := newFakeProcess(func(text string, self *fakeProcess) {
		id, _ := controlOf(text)
		answerControl(self, id, map[string]any{})
		self.end(intPtr(1))
	})
	useFakeSpawner(t, fake)
	_, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{})
	if err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("err = %v", err)
	}
	if got := len(fake.writes()); got != 1 {
		t.Fatalf("writes = %d", got)
	}
}

func TestExitBeforeAnAnswerFailsAndReleasesTheSubprocess(t *testing.T) {
	useHelp(t, always(helpWithSafeMode))
	fake := newFakeProcess(func(_ string, self *fakeProcess) { self.end(intPtr(1)) })
	useFakeSpawner(t, fake)
	_, err := AccountUsage(usageCtx(t), usageInstallation, oar.AccountUsageReadOptions{})
	if err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("err = %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestUnsupportedInstallationNeverLaunchesAProcess(t *testing.T) {
	spawner := useFakeSpawner(t, newFakeProcess(nil))
	snapshot, err := AccountUsage(usageCtx(t), oar.AvailableInstallation{Via: "bundled"}, oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"unsupported","reason":"unsupported_installation"}`)
	if spawner.count() != 0 {
		t.Fatal("spawned")
	}
}

func TestNativeWindowsIncludeModelBucketsWithoutLegacyFields(t *testing.T) {
	snapshot, err := ProjectClaudeUsage(map[string]any{"subscription_type": " max ", "rate_limits_available": true, "rate_limits": map[string]any{
		"five_hour":            map[string]any{"utilization": 7.0, "resets_at": "2026-08-22T09:59:00Z"},
		"seven_day":            map[string]any{"utilization": 14.0},
		"seven_day_oauth_apps": map[string]any{"utilization": 3.0},
		"seven_day_opus":       map[string]any{"utilization": 100.0},
		"model_scoped":         []any{map[string]any{"display_name": "Fable", "utilization": 105.0, "resets_at": "invalid"}},
	}}, "")
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"available","plan":"max","rateLimited":true,"windows":[
		{"label":"Current session","usedRatio":0.07,"resetsAt":"2026-08-22T09:59:00.000Z","id":"five_hour","durationMs":18000000},
		{"label":"Current week (all models)","usedRatio":0.14,"id":"seven_day","durationMs":604800000},
		{"label":"Current week (OAuth apps)","usedRatio":0.03,"id":"seven_day_oauth_apps","durationMs":604800000},
		{"label":"Current week (Fable)","usedRatio":1,"id":"model_scoped:Fable","durationMs":604800000}]}`)
}

func TestLegacyNativeModelWindowsAndPaidHeadroomRemainDistinct(t *testing.T) {
	snapshot, err := ProjectClaudeUsage(map[string]any{"rate_limits_available": true, "rate_limits": map[string]any{
		"seven_day_opus": map[string]any{"utilization": 100.0}, "seven_day_sonnet": map[string]any{"utilization": 0.0},
		"extra_usage": map[string]any{"is_enabled": true, "utilization": 25.0, "monthly_limit": 100.0, "used_credits": 25.0},
	}}, "")
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, snapshot, `{"kind":"available","rateLimited":false,"windows":[
		{"label":"Current week (Opus)","usedRatio":1,"id":"seven_day_opus","durationMs":604800000},
		{"label":"Current week (Sonnet)","usedRatio":0,"id":"seven_day_sonnet","durationMs":604800000},
		{"label":"Extra usage","usedRatio":0.25,"id":"extra_usage"}]}`)
}

func TestMalformedSnapshotIsNeverManufacturedAsZeroUsage(t *testing.T) {
	for _, payload := range []any{
		map[string]any{}, map[string]any{"rate_limits_available": "false"}, map[string]any{"rate_limits_available": true, "rate_limits": nil},
		map[string]any{"rate_limits_available": true, "rate_limits": map[string]any{}},
		map[string]any{"rate_limits_available": true, "rate_limits": map[string]any{"five_hour": map[string]any{"utilization": nil}}},
		map[string]any{"rate_limits_available": true, "rate_limits": map[string]any{"five_hour": map[string]any{"utilization": -1.0}}},
		map[string]any{"rate_limits_available": true, "rate_limits": map[string]any{"five_hour": map[string]any{"utilization": math.NaN()}}},
	} {
		if _, err := ProjectClaudeUsage(payload, ""); err == nil {
			t.Fatalf("%v projected without an error", payload)
		}
	}
}
