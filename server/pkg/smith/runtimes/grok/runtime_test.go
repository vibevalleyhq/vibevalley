package grok

// grok's cases of the cross-runtime TS tests: tests/installation.test.ts,
// install-runtimes.test.ts, account-usage.test.ts, list-models.test.ts,
// update-projections.test.ts, failure-mapping.test.ts, reasoning-tokens.test.ts,
// refused-session-options.test.ts and registry.test.ts.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func TestCandidatesMatchTheOfficialScriptAndNpmLayouts(t *testing.T) {
	jsonEqual(t, InstalledExecutableCandidates("linux", "/home/oar", map[string]string{"GROK_BIN_DIR": "/opt/grok-cli", "GROK_HOME": "/var/lib/grok"}),
		[]string{"/opt/grok-cli/grok", "/var/lib/grok/bin/grok", "/home/oar/.grok/bin/grok"})
	jsonEqual(t, InstalledExecutableCandidates("win32", `C:\Users\oar`, map[string]string{"GROK_BIN_DIR": `D:\Grok CLI`, "GROK_HOME": `D:\Grok Home`}),
		[]string{`D:\Grok CLI\grok.exe`, `D:\Grok Home\bin\grok.exe`, `C:\Users\oar\.grok\bin\grok.exe`})
}

func TestGrokGatesItsACPEntrypoint(t *testing.T) {
	t.Setenv("OAR_GROK_BIN", nodePath(t))
	snapshot, err := Installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "unsupported", "reason": "agent stdio --help failed"})
}

var linuxHost = shared.InstallHost{Platform: "linux", Arch: "arm64", Locate: func(tool string) string { return "/usr/bin/" + tool }, Unwritable: func(string) string { return "" }}

func TestTheScriptInstallRunsXAIsDocumentedLineCitedByItsDocumentationPage(t *testing.T) {
	plan := shared.ScriptInstallPlanOn(InstallMethod, linuxHost)
	if plan.Kind != "plan" || len(plan.Steps) != 1 || plan.Steps[0].Display != "curl -fsSL https://x.ai/cli/install.sh | bash" || plan.Source != "https://docs.x.ai/build/overview" {
		t.Fatalf("%+v", plan)
	}
}

// ─── account-usage.test.ts ─────────────────────────────────────────────────

func project(t *testing.T, raw string, email string) oar.AccountUsageSnapshot {
	t.Helper()
	snapshot, err := ProjectUsage(decodeJSON(t, raw), email)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func decodeJSON(t *testing.T, raw string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestProjectionPreservesTheVendorBillingWindowAndAuthenticatedEmail(t *testing.T) {
	jsonEqual(t, project(t, `{"config": {"creditUsagePercent": 22.5,
		"currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-08-24T00:00:00Z", "end": "2026-08-31T00:00:00Z"},
		"prepaidBalance": {"val": 500}, "isUnifiedBillingUser": true},
		"onDemandEnabled": true, "subscription_tier": "SuperGrok"}`, "person@example.com"), `{
		"email": "person@example.com", "kind": "available", "plan": "SuperGrok", "rateLimited": false,
		"windows": [{"label": "Weekly included usage", "resetsAt": "2026-08-31T00:00:00.000Z", "usedRatio": 0.225}]}`)
}

func TestAccountEmailAcceptsOnlyANonEmptyAuthInfoField(t *testing.T) {
	if got := AccountEmail(map[string]any{"email": " person@example.com "}); got != "person@example.com" {
		t.Fatal(got)
	}
	for _, value := range []any{"", 42.0} {
		if got := AccountEmail(map[string]any{"email": value}); got != "" {
			t.Fatal(got)
		}
	}
}

func TestProjectionFallsBackToLegacyUsedLimitCents(t *testing.T) {
	jsonEqual(t, project(t, `{"config": {"used": {"val": 250}, "monthlyLimit": {"val": 1000}, "billingPeriodEnd": "2026-09-01T00:00:00Z"}}`, ""), `{
		"kind": "available", "rateLimited": false,
		"windows": [{"label": "Included usage", "resetsAt": "2026-09-01T00:00:00.000Z", "usedRatio": 0.25}]}`)
	jsonEqual(t, project(t, `{"config": null}`, ""), map[string]any{"kind": "unsupported", "reason": "quota_unavailable"})
}

func TestProjectionDefaultsOmittedMetricsToZeroButRejectsMalformedUsage(t *testing.T) {
	unused := `{"kind": "available", "rateLimited": false, "windows": [{"label": "Included usage", "usedRatio": 0}]}`
	jsonEqual(t, project(t, `{"config": {}}`, ""), unused)
	jsonEqual(t, project(t, `{"config": {"creditUsagePercent": null, "used": null, "monthlyLimit": null}}`, ""), unused)
	if snapshot := project(t, `{"config": {"creditUsagePercent": 0}}`, ""); snapshot.Kind != "available" || snapshot.Windows[0].UsedRatio != 0 || snapshot.RateLimited {
		t.Fatalf("%+v", snapshot)
	}
	for _, config := range []string{`{"creditUsagePercent": "invalid"}`, `{"creditUsagePercent": -1}`, `{"used": {"val": 100}, "monthlyLimit": {"val": 0}}`} {
		_, err := ProjectUsage(decodeJSON(t, `{"config": `+config+`}`), "")
		if err == nil || !strings.Contains(err.Error(), "no usable account usage percentage") {
			t.Fatalf("%s: %v", config, err)
		}
	}
}

func TestProjectionKeepsPaidHeadroomDistinctFromIncludedUsage(t *testing.T) {
	jsonEqual(t, project(t, `{"config": {"creditUsagePercent": 100, "currentPeriod": {"type": "USAGE_PERIOD_TYPE_MONTHLY", "end": "2026-09-01T00:00:00Z"},
		"onDemandCap": {"val": 5000}, "onDemandUsed": {"val": 1250}}}`, ""), `{
		"kind": "available", "rateLimited": false,
		"windows": [
			{"label": "Monthly included usage", "resetsAt": "2026-09-01T00:00:00.000Z", "usedRatio": 1},
			{"label": "Pay-as-you-go", "resetsAt": "2026-09-01T00:00:00.000Z", "usedRatio": 0.25}]}`)
	if snapshot := project(t, `{"config": {"creditUsagePercent": 100, "prepaidBalance": {"val": -500}}}`, ""); snapshot.Kind != "available" || snapshot.RateLimited {
		t.Fatalf("%+v", snapshot)
	}
	if snapshot := project(t, `{"config": {"creditUsagePercent": 100, "onDemandCap": {"val": 1000}, "onDemandUsed": {"val": 1000}}}`, ""); snapshot.Kind != "available" || !snapshot.RateLimited {
		t.Fatalf("%+v", snapshot)
	}
}

// ─── list-models.test.ts ───────────────────────────────────────────────────

func TestProjectionUnwrapsTheHandlerEnvelopeAndFiltersUnselectableModels(t *testing.T) {
	state, err := ModelState(decodeJSON(t, `{"result": {"currentModelId": "grok-4", "availableModels": [
		{"modelId": "grok-4", "name": "Grok 4", "reasoning_efforts": ["low", {"effort": "high"}], "default_reasoning_effort": "low"},
		{"model_id": "grok-hidden", "hidden": true},
		{"modelId": "grok-internal", "user_selectable": false},
		{"modelId": "grok-3-mini", "displayName": "Grok 3 mini"}]}}`))
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, ProjectModels(state), `[
		{"id": "grok-4", "displayName": "Grok 4", "effortLevels": ["low", "high"], "defaultEffort": "low", "default": true},
		{"id": "grok-3-mini", "displayName": "Grok 3 mini"}]`)
	flat, err := ModelState(decodeJSON(t, `{"available_models": [{"id": "flat"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, ProjectModels(flat), `[{"id": "flat"}]`)
	if _, err := ModelState(decodeJSON(t, `{"error": {"message": "boom"}}`)); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatal(err)
	}
}

func TestExecutableListerRefusesBundledInstallations(t *testing.T) {
	listed, err := ListModels(context.Background(), oar.AvailableInstallation{Via: "bundled"}, oar.ListModelsOptions{})
	if err != nil || listed.Kind != "unsupported" {
		t.Fatalf("%+v %v", listed, err)
	}
}

// ─── update-projections.test.ts ────────────────────────────────────────────

func TestChecksJSONDecidesAndALookupErrorIsNeverACurrentInstallation(t *testing.T) {
	ok := ProjectUpdateCheck("1.0.44", decodeJSON(t, `{"currentVersion": "1.0.44", "latestVersion": "1.0.46", "updateAvailable": true, "installer": "internal", "channel": "stable", "error": null}`))
	jsonEqual(t, ok, map[string]any{"kind": "ok", "installed": "1.0.44", "latest": "1.0.46", "updateAvailable": true, "channel": "stable", "source": "grok update --check --json"})
	failed := ProjectUpdateCheck("1.0.46", decodeJSON(t, `{"latestVersion": null, "updateAvailable": false, "error": "GCS channel pointer fetch failed"}`))
	if failed.Kind != "unavailable" || failed.Reason != "lookup_failed" {
		t.Fatalf("%+v", failed)
	}
	if got := ProjectUpdateCheck("1.0.46", nil); got.Kind != "unavailable" {
		t.Fatalf("%+v", got)
	}
}

// ─── failure-mapping.test.ts ───────────────────────────────────────────────

func retryState(update map[string]any) oar.FrameBody {
	fields := map[string]any{"sessionUpdate": "retry_state"}
	for key, value := range update {
		fields[key] = value
	}
	return oar.FrameBody{Type: "_x.ai/session_notification", Native: jsonx.Marshal(map[string]any{"sessionId": "s", "update": fields}), Events: []oar.EventBody{}}
}

func TestFailureMapping(t *testing.T) {
	for _, c := range []struct {
		name    string
		err     error
		frames  []oar.FrameBody
		failure oar.FailureClass
	}{
		{"any 429", acp.NewRequestError(-32003, "Rate limited", "API error (status 429 Too Many Requests): …"), []oar.FrameBody{retryState(map[string]any{"type": "exhausted", "is_rate_limited": true})}, oar.FailureRateLimited},
		{"invalid key", acp.InternalError("Unauthorized (401) …"), []oar.FrameBody{retryState(map[string]any{"type": "failed", "error_type": "auth"})}, oar.FailureAuth},
		{"oversized context", acp.InternalError("…"), []oar.FrameBody{retryState(map[string]any{"type": "failed", "error_type": "context_length"})}, oar.FailureInputTooLarge},
		{"unentitled model", acp.InternalError("…"), []oar.FrameBody{retryState(map[string]any{"type": "retrying", "error_type": "rate_limited"}), retryState(map[string]any{"type": "failed", "error_type": "api"})}, oar.FailureProvider},
	} {
		t.Run(c.name, func(t *testing.T) {
			outcome := acp.FailureOutcome(c.err, c.frames, FailureOutcome)
			if outcome.Kind != "failed" || outcome.Failure != c.failure {
				t.Fatalf("%+v", outcome)
			}
		})
	}
}

func TestAFailureWithNoFinalRetryStateFallsToTheGenericRules(t *testing.T) {
	if outcome := FailureOutcome(acp.InternalError("x"), []oar.FrameBody{retryState(map[string]any{"type": "retrying", "error_type": "api"})}); outcome != nil {
		t.Fatalf("%+v", outcome)
	}
}

// ─── reasoning-tokens.test.ts ──────────────────────────────────────────────

func TestPromptAndIndependentWakeLedgersPreserveNativeReasoning(t *testing.T) {
	for _, reasoning := range []*int64{nil, oar.Int64(0), oar.Int64(4)} {
		usage := map[string]any{"inputTokens": 10, "outputTokens": 5}
		tokens := map[string]any{"input": 10, "output": 5}
		if reasoning != nil {
			usage["reasoningTokens"] = *reasoning
			tokens["reasoning"] = *reasoning
		}
		jsonEqual(t, PromptTokens(jsonx.Record{"_meta": map[string]any{"usage": usage}}), tokens)
		jsonEqual(t, SpontaneousTokens("_x.ai/session_notification", jsonx.ParseRecord(jsonx.Marshal(map[string]any{
			"_meta":  map[string]any{"eventId": "event-1"},
			"update": map[string]any{"sessionUpdate": "turn_completed", "prompt_id": "subagent-completed-child", "usage": usage},
		}))), map[string]any{"Key": "event-1", "Tokens": tokens, "Replayed": false})
	}
}

// ─── refused-session-options.test.ts, registry.test.ts ─────────────────────

func TestRuntimeShape(t *testing.T) {
	runtime := Runtime()
	if runtime.ID != "grok" || runtime.Brand.Name == "" || runtime.Install == nil || runtime.InstallPlan == nil || runtime.AccountUsage == nil ||
		runtime.ListModels == nil || runtime.CheckUpdate == nil || runtime.Upgrade == nil || runtime.Login != nil {
		t.Fatalf("%+v", runtime)
	}
	tools, err := runtime.Tools(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "fake"}, oar.InventoryOptions{})
	if err != nil || tools.Kind != "unsupported" {
		t.Fatalf("%+v %v", tools, err)
	}
	commands, err := runtime.Commands(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "fake"}, oar.InventoryOptions{})
	if err != nil || commands.Kind != "unsupported" || commands.Code != "transport_unavailable" {
		t.Fatalf("%+v %v", commands, err)
	}
}
