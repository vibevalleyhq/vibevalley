package kimi

// Ported from tests/kimi/kimi-account-usage.test.ts.

import (
	"encoding/json"
	"fmt"
	"testing"
)

var managedUsageFixture = json.RawMessage(`{
	"usage": {"used": "225", "limit": "1000", "resetTime": "2026-08-31T00:00:00Z"},
	"limits": [
		{"window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"}, "detail": {"used": "50", "limit": "100", "resetTime": "2026-08-27T10:00:00Z"}},
		{"name": "Daily cap", "detail": {"used": 7, "limit": 10}}
	],
	"boosterWallet": {
		"balance": {"type": "BOOSTER", "amount": "20000000000", "amountLeft": "10000000000"},
		"monthlyChargeLimitEnabled": true,
		"monthlyChargeLimit": {"currency": "CNY", "priceInCents": "20000"},
		"monthlyUsed": {"currency": "CNY", "priceInCents": "5000"}
	}
}`)

func decode(t *testing.T, raw string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestProjectionMirrorsTheManagedQuotaRowsRenderedByUsage(t *testing.T) {
	jsonEqual(t, ProjectUsage(decode(t, string(managedUsageFixture)), "person@example.com", "Vivace", ""), json.RawMessage(`{
		"email": "person@example.com", "kind": "available", "plan": "Vivace", "rateLimited": false,
		"windows": [
			{"label": "Weekly limit", "resetsAt": "2026-08-31T00:00:00.000Z", "usedRatio": 0.225},
			{"label": "5h limit", "resetsAt": "2026-08-27T10:00:00.000Z", "usedRatio": 0.5},
			{"label": "Daily cap", "usedRatio": 0.7},
			{"label": "Extra Usage monthly limit", "usedRatio": 0.25}
		]}`))
}

func TestAccountEmailRequiresAnAuthenticatedProfileShape(t *testing.T) {
	if got := AccountEmail(map[string]any{"user_id": "user-1", "email": " person@example.com "}); got != "person@example.com" {
		t.Fatal(got)
	}
	if got := AccountEmail(map[string]any{"email": "person@example.com"}); got != "" {
		t.Fatal(got)
	}
	if got := AccountEmail(map[string]any{"user_id": "user-1", "email": ""}); got != "" {
		t.Fatal(got)
	}
}

func TestAccountDisplayNameReadsTheAuthenticatedProfilesNickname(t *testing.T) {
	if got := AccountDisplayName(map[string]any{"user_id": "user-1", "nickname": " 登月者8387 "}); got != "登月者8387" {
		t.Fatal(got)
	}
	if got := AccountDisplayName(map[string]any{"nickname": "登月者8387"}); got != "" {
		t.Fatal(got)
	}
	if got := AccountDisplayName(map[string]any{"user_id": "user-1", "nickname": ""}); got != "" {
		t.Fatal(got)
	}
}

func TestAccountPlanRequiresTheAuthenticatedProfilesNamedMembershipLevel(t *testing.T) {
	if got := AccountPlan(map[string]any{"user_id": "user-1", "user_level_name": " Vivace "}); got != "Vivace" {
		t.Fatal(got)
	}
	if got := AccountPlan(map[string]any{"user_level_name": "Vivace"}); got != "" {
		t.Fatal(got)
	}
	if got := AccountPlan(map[string]any{"user_id": "user-1", "user_level_name": ""}); got != "" {
		t.Fatal(got)
	}
	if got := AccountPlan(map[string]any{"user_id": "user-1", "user_level": 4}); got != "" {
		t.Fatal(got)
	}
}

func TestProjectionClampsExhaustedWindowsAndSkipsUnusableLimits(t *testing.T) {
	jsonEqual(t, ProjectUsage(decode(t, `{
		"usage": {"used": "101", "limit": "100"},
		"limits": [
			{"detail": {"used": 5, "limit": 0}},
			{"detail": {"used": -1, "limit": 10}},
			{"detail": {"limit": 20}, "window": {"duration": 2, "timeUnit": "TIME_UNIT_DAY"}}
		]}`), "", "", ""), json.RawMessage(`{
		"kind": "available", "rateLimited": true,
		"windows": [{"label": "Weekly limit", "usedRatio": 1}, {"label": "2d limit", "usedRatio": 0}]}`))
}

func TestExtraUsageHeadroomBypassesExhaustedSubscriptionWindows(t *testing.T) {
	payload := `{
		"usage": {"used": "100", "limit": "100"},
		"boosterWallet": {
			"balance": {"type": "BOOSTER", "amount": "20000000000", "amountLeft": "10000000000"},
			"monthlyChargeLimitEnabled": true,
			"monthlyChargeLimit": {"currency": "CNY", "priceInCents": "20000"},
			"monthlyUsed": {"currency": "CNY", "priceInCents": "%s"}
		}}`
	if snapshot := ProjectUsage(decode(t, fmt.Sprintf(payload, "5000")), "", "", ""); snapshot.Kind != "available" || snapshot.RateLimited {
		t.Fatalf("%+v", snapshot)
	}
	if snapshot := ProjectUsage(decode(t, fmt.Sprintf(payload, "20000")), "", "", ""); snapshot.Kind != "available" || !snapshot.RateLimited {
		t.Fatalf("%+v", snapshot)
	}
}
