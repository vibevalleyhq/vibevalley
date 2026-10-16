//go:build wip_a

package claude

import (
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-limit-reset.test.ts. A claude.ai subscription's
// limit: claude reports each change of its limits as a rate_limit_event, the
// refusal's before the turn's error frame and result. Shapes from Agent SDK
// 0.3.295 SDKRateLimitInfo and the claude 2.1.289 binary.

const (
	limitReset   = 1_791_558_000 // 2026-10-09T15:00:00Z, in unix seconds as claude sends it
	limitResetAt = "2026-10-09T15:00:00.000Z"
	limitText    = "You've hit your session limit · resets 3pm"
)

func rateLimitEvent(info map[string]any) map[string]any {
	return map[string]any{"type": "rate_limit_event", "rate_limit_info": info, "uuid": "00000000-0000-4000-8000-000000000000", "session_id": "s"}
}

var rejectedLimit = rateLimitEvent(map[string]any{"status": "rejected", "resetsAt": limitReset, "rateLimitType": "five_hour", "overageStatus": "rejected", "overageDisabledReason": "org_level_disabled", "isUsingOverage": false})

var refusedTurn = []map[string]any{
	{"type": "assistant", "error": "rate_limit", "message": map[string]any{"model": "<synthetic>", "content": []any{map[string]any{"type": "text", "text": limitText}}}},
	{"type": "result", "subtype": "success", "is_error": true, "api_error_status": 429, "terminal_reason": "api_error", "result": limitText},
}

// throttled: the same refusal with no rejected rate_limit_event naming a reset.
const throttledJSON = `{"kind":"failed","reason":"` + limitText + `","failure":"rate_limited","status":429}`

// limited: a subscription limit refusing until a named reset: a usage limit.
const limitedJSON = `{"kind":"failed","reason":"` + limitText + `","failure":"quota","status":429,"resetsAt":"` + limitResetAt + `"}`

func outcomesOf(frames []map[string]any) []oar.TurnOutcome {
	outcomes := []oar.TurnOutcome{}
	state := claudePrompted(initialClaudeProjection(), "", true)
	for _, frame := range frames {
		var commands []projectionCommand
		state, commands = fold(state, frame)
		for _, command := range commands {
			if command.Kind != "frame" {
				continue
			}
			for _, view := range command.Body.Events {
				if ended, ok := view.(oar.TurnEnded); ok {
					outcomes = append(outcomes, ended.Outcome)
					break
				}
			}
		}
	}
	return outcomes
}

func withFrames(first []map[string]any, rest ...map[string]any) []map[string]any {
	return append(append([]map[string]any{}, first...), rest...)
}

func TestRateLimitFailureAfterARejectedEventIsQuotaWithTheReset(t *testing.T) {
	assertJSON(t, outcomesOf(withFrames([]map[string]any{rejectedLimit}, refusedTurn...)), "["+limitedJSON+"]")
}

func TestRateLimitFailureWithNoEventStaysRateLimited(t *testing.T) {
	assertJSON(t, outcomesOf(refusedTurn), "["+throttledJSON+"]")
}

func TestThroughASessionTheRefusedTurnEndsQuotaAndALaterRefusalKeepsTheLastReport(t *testing.T) {
	ctx := testContext(t)
	fake, session := openFake(t, oar.SessionOptions{})
	emit := func(frames []map[string]any) {
		chunk := ""
		for _, frame := range frames {
			chunk += jsonText(frame) + "\n"
		}
		fake.emit(chunk)
	}
	first := prompt(t, session, "go on", "")
	warning := rateLimitEvent(map[string]any{"status": "allowed_warning", "resetsAt": limitReset, "rateLimitType": "five_hour", "utilization": 0.9})
	emit(withFrames([]map[string]any{warning, rejectedLimit}, refusedTurn...))
	assertJSON(t, turnEnd(t, session, first.Request.Seq, ""), limitedJSON)
	// Read for the outcome only: the frame is recorded verbatim, with no event of its own.
	var bodies []oar.FrameBody
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && record.Frame.Type == "rate_limit_event" {
			bodies = append(bodies, record.Frame)
		}
	}
	if len(bodies) != 2 || len(bodies[0].Events) != 0 {
		t.Fatalf("rate_limit_event frames = %v", bodies)
	}
	assertJSON(t, bodies[1], `{"type":"rate_limit_event","native":`+jsonText(rejectedLimit)+`,"events":[]}`)

	// Refused again with nothing changed: claude need not report again, and its last report stands.
	second := prompt(t, session, "go on", "")
	emit(refusedTurn)
	assertJSON(t, turnEnd(t, session, second.Request.Seq, ""), limitedJSON)
	if err := session.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRateLimitedWithNoResetUnlessTheLatestEventNamesOne(t *testing.T) {
	for _, info := range []map[string]any{
		{"status": "allowed", "resetsAt": limitReset, "rateLimitType": "five_hour"},
		{"status": "allowed_warning", "resetsAt": limitReset, "rateLimitType": "seven_day", "utilization": 0.8},
		// Paid overage takes the requests the plan limit refuses.
		{"status": "rejected", "resetsAt": limitReset, "rateLimitType": "five_hour", "overageStatus": "allowed", "isUsingOverage": true},
		{"status": "rejected", "rateLimitType": "five_hour"},
		// claude's own reading of a subscriber's 429 without limit headers: rejected, no reset.
		{"status": "rejected", "isUsingOverage": false},
		{"status": "rejected", "resetsAt": "soon"},
	} {
		assertJSON(t, outcomesOf(withFrames([]map[string]any{rateLimitEvent(info)}, refusedTurn...)), "["+throttledJSON+"]")
	}
	// A later event replaces the rejection: the limit no longer refuses.
	allowed := rateLimitEvent(map[string]any{"status": "allowed", "resetsAt": limitReset + 18_000, "rateLimitType": "five_hour"})
	assertJSON(t, outcomesOf(withFrames([]map[string]any{rejectedLimit, allowed}, refusedTurn...)), "["+throttledJSON+"]")
}

func TestOnlyAFailureClaudeCategorizesRateLimitBecomesQuota(t *testing.T) {
	assertJSON(t, outcomesOf([]map[string]any{
		rejectedLimit,
		{"type": "assistant", "error": "server_error", "message": map[string]any{"model": "<synthetic>", "content": []any{map[string]any{"type": "text", "text": "API Error: 529 Overloaded."}}}},
		{"type": "result", "subtype": "success", "is_error": true, "api_error_status": 529, "terminal_reason": "api_error", "result": "API Error: 529 Overloaded."},
		{"type": "result", "subtype": "success", "is_error": false, "result": "done"},
	}), `[{"kind":"failed","reason":"API Error: 529 Overloaded.","failure":"overloaded","status":529},{"kind":"completed"}]`)
	assertJSON(t, claudeFailure("Credit balance is too low", claudeFailureFacts{Category: "billing_error", Status: intPtr(400), TerminalReason: "api_error", LimitResetsAt: limitResetAt}),
		`{"kind":"failed","reason":"Credit balance is too low","failure":"billing","status":400}`)
	assertJSON(t, claudeFailure("Not logged in · Please run /login", claudeFailureFacts{Category: "authentication_failed", TerminalReason: "api_error", LimitResetsAt: limitResetAt}),
		`{"kind":"failed","reason":"Not logged in · Please run /login","failure":"auth","credential":"missing"}`)
}
