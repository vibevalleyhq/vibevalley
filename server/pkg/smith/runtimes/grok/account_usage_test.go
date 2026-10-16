package grok

// Ported from tests/grok/grok-account-usage-reader.test.ts. The TS mocks
// startAcpProcess and withAcpDeadline; here a scripted agent answers
// (scripted_test.go) and the deadline is real.

import (
	"context"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

func billing() any {
	return map[string]any{"config": map[string]any{"creditUsagePercent": 25}, "subscription_tier": "SuperGrok"}
}

var initialized = result(map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{}, "authMethods": []any{}})

func TestReaderMatchesNativeZeroUsageForBillingWithoutUsageMetrics(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize": initialized,
		// Grok 1.0.46 returns this shape for an authenticated SuperGrok account.
		"_x.ai/billing": result(map[string]any{
			"config": map[string]any{
				"currentPeriod":        map[string]any{"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-10-01T00:00:00Z", "end": "2026-10-08T00:00:00Z"},
				"onDemandCap":          map[string]any{"val": 0},
				"onDemandUsed":         map[string]any{"val": 0},
				"prepaidBalance":       map[string]any{"val": 0},
				"isUnifiedBillingUser": true,
				"billingPeriodStart":   "2026-10-01T00:00:00Z",
				"billingPeriodEnd":     "2026-10-08T00:00:00Z",
			},
			"subscription_tier": "SuperGrok",
		}),
		"_x.ai/auth/info": result(map[string]any{"methodId": "cached_token", "email": "person@example.com"}),
	})
	snapshot, err := AccountUsage(context.Background(), agent.installation(), oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{
		"kind": "available", "plan": "SuperGrok", "email": "person@example.com", "rateLimited": false,
		"windows": []any{map[string]any{"label": "Weekly included usage", "usedRatio": 0, "resetsAt": "2026-10-08T00:00:00.000Z"}},
	})
	if !agent.killed() {
		t.Fatal("the agent outlived the read")
	}
}

func TestReaderMergesEmailFromTheAuthenticatedAuthInfoExtension(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":      initialized,
		"_x.ai/billing":   result(billing()),
		"_x.ai/auth/info": result(map[string]any{"methodId": "cached_token", "email": "person@example.com"}),
	})
	snapshot, err := AccountUsage(context.Background(), agent.installation(), oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Kind != "available" || snapshot.Plan != "SuperGrok" || snapshot.Email != "person@example.com" || snapshot.RateLimited {
		t.Fatalf("%+v", snapshot)
	}
	equalMethods(t, agent.methods(), "initialize", "_x.ai/billing", "_x.ai/auth/info")
	if !agent.killed() {
		t.Fatal("the agent outlived the read")
	}
}

func TestReaderKeepsBillingWhenTheOptionalAuthInfoExtensionFails(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":      initialized,
		"_x.ai/billing":   result(billing()),
		"_x.ai/auth/info": rpcError(-32603, "method unavailable"),
	})
	snapshot, err := AccountUsage(context.Background(), agent.installation(), oar.AccountUsageReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, snapshot, map[string]any{"kind": "available", "plan": "SuperGrok", "rateLimited": false, "windows": []any{map[string]any{"label": "Included usage", "usedRatio": 0.25}}})
}

// Timeout bounds the whole read: each request gets what is left of it. TS
// reads the budget each request was given off the mocked deadline wrapper;
// here the start and the first two answers spend at least 2 s of a 6 s
// budget, so `_x.ai/auth/info`, which answers after 5 s (inside a fresh 6 s
// budget), misses what is left: the email is dropped and the billing kept.
func TestReaderGivesEachRequestOnlyWhatIsLeftOfTheTimeout(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{
		"initialize":      delayed(time.Second, initialized),
		"_x.ai/billing":   delayed(time.Second, result(billing())),
		"_x.ai/auth/info": delayed(5*time.Second, result(map[string]any{"email": "person@example.com"})),
	})
	snapshot, err := AccountUsage(context.Background(), agent.installation(), oar.AccountUsageReadOptions{Timeout: 6 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Kind != "available" || snapshot.Email != "" {
		t.Fatalf("%+v", snapshot)
	}
	equalMethods(t, agent.methods(), "initialize", "_x.ai/billing", "_x.ai/auth/info")
}

func TestReaderRejectsOnceTheTimeoutIsSpent(t *testing.T) {
	agent := newScriptedAgent(t, map[string]any{"initialize": delayed(2500*time.Millisecond, initialized)})
	_, err := AccountUsage(context.Background(), agent.installation(), oar.AccountUsageReadOptions{Timeout: 2 * time.Second})
	if err == nil || !strings.Contains(err.Error(), "Failed to read Grok account usage") {
		t.Fatalf("%v", err)
	}
	equalMethods(t, agent.methods(), "initialize")
}

func equalMethods(t *testing.T, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("methods %q, want %q", got, want)
	}
}
