package claude

import (
	"testing"
)

// Ports the claude cases of tests/failure-mapping.test.ts.

// claude 2.1.292: the assistant frame's error, the result's api_error_status and terminal_reason.
func TestClaudeFailureMapping(t *testing.T) {
	for _, tc := range []struct {
		name, reason, category string
		status                 *int
		terminalReason         string
		expected               string
	}{
		{"missing login", "Not logged in · Please run /login", "authentication_failed", nil, "api_error", `"failure":"auth","credential":"missing"`},
		{"invalid key", "Invalid API key · Fix external API key", "authentication_failed", intPtr(401), "api_error", `"failure":"auth","credential":"rejected","status":401`},
		{"unknown model", "There's an issue with the selected model", "model_not_found", intPtr(404), "api_error", `"failure":"model_unavailable","status":404`},
		{"rate limited", "API Error: Request rejected (429)", "rate_limit", intPtr(429), "api_error", `"failure":"rate_limited","status":429`},
		{"spend limit", "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.", "unknown", intPtr(400), "api_error", `"failure":"quota","status":400`},
		{"credit balance", "Credit balance is too low", "billing_error", intPtr(400), "api_error", `"failure":"billing","status":400`},
		{"402", "API Error: 402 This organization has a billing issue.", "unknown", intPtr(402), "api_error", `"failure":"billing","status":402`},
		{"500", "API Error: 500 Internal server error.", "server_error", intPtr(500), "api_error", `"failure":"provider","status":500`},
		{"529", "API Error: 529 Overloaded.", "server_error", intPtr(529), "api_error", `"failure":"overloaded","status":529`},
		{"oversized context", "Prompt is too long", "invalid_request", intPtr(400), "prompt_too_long", `"failure":"input_too_large","status":400`},
		{"an invalid request", "API Error: 400 max_tokens exceeds model limit", "invalid_request", intPtr(400), "api_error", `"failure":"invalid_request","status":400`},
		{"a declared category no run produced", "Your account is on hold", "account_on_hold", intPtr(403), "api_error", `"failure":"unknown","status":403`},
		{"no category and no status", "error", "", nil, "", `"failure":"unknown"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := claudeFailure(tc.reason, claudeFailureFacts{Category: tc.category, Status: tc.status, TerminalReason: tc.terminalReason})
			assertJSON(t, got, `{"kind":"failed","reason":`+jsonText(tc.reason)+`,`+tc.expected+`}`)
		})
	}
}

// #339 (claude 2.1.296): a limit or schema the host set is its own class.
func TestClaudeFailureResultSubtype(t *testing.T) {
	for _, tc := range []struct{ subtype, expected string }{
		{"error_max_turns", "limit_reached"},
		{"error_max_budget_usd", "limit_reached"},
		{"error_max_structured_output_retries", "output_schema"},
		{"error_during_execution", "unknown"},
	} {
		got := claudeFailure(tc.subtype, claudeFailureFacts{Subtype: tc.subtype})
		assertJSON(t, got, `{"kind":"failed","reason":"`+tc.subtype+`","failure":"`+tc.expected+`"}`)
	}
}

func TestClaudeResultReasonKeepsTheSubtypeAndAddsErrorsText(t *testing.T) {
	for _, tc := range []struct {
		subtype string
		errors  any
		want    string
	}{
		{"error_max_turns", []any{"Reached maximum number of turns (2)"}, "error_max_turns: Reached maximum number of turns (2)"},
		{"error_max_turns", nil, "error_max_turns"},
		{"", []any{"a", 3.0, "", "b"}, "a; b"},
		{"", []any{}, "error"},
	} {
		if got := claudeResultReason(tc.subtype, tc.errors); got != tc.want {
			t.Fatalf("claudeResultReason(%q, %v) = %q, want %q", tc.subtype, tc.errors, got, tc.want)
		}
	}
}
