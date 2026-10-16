package codex

import (
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
)

// Ports the codex part of tests/failure-mapping.test.ts (codex 0.160.1: `turn.error.codexErrorInfo`).
func TestFailureMapping(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		info     any
		message  string
		expected string
	}{
		{"missing login or invalid key", jsonx.Record{"httpConnectionFailed": jsonx.Record{"httpStatusCode": 401}}, "", `{"failure":"auth","status":401}`},
		{"unknown model", jsonx.Record{"httpConnectionFailed": jsonx.Record{"httpStatusCode": 404}}, "", `{"failure":"model_unavailable","status":404}`},
		{"rate limited", jsonx.Record{"responseTooManyFailedAttempts": jsonx.Record{"httpStatusCode": 429}}, "", `{"failure":"rate_limited","status":429}`},
		{"usage limit or billing", "usageLimitExceeded", "Quota exceeded. Check your plan and billing details.", `{"failure":"quota"}`},
		{"rate limited in the stream", "rateLimitExceeded", "", `{"failure":"rate_limited"}`},
		{"server error", "internalServerError", "", `{"failure":"provider"}`},
		{"overloaded", "serverOverloaded", "Selected model is at capacity.", `{"failure":"overloaded"}`},
		{"oversized context in the stream", "contextWindowExceeded", "", `{"failure":"input_too_large"}`},
		{"oversized context as an HTTP 400", "other", `{"error":{"message":"Your input exceeds the context window of this model.","type":"invalid_request_error","param":null,"code":"context_length_exceeded"}}`, `{"failure":"input_too_large"}`},
		{"other with words only", "other", "something broke", `{"failure":"unknown"}`},
		{"a declared value no run produced", "unauthorized", "", `{"failure":"unknown"}`},
		{"a disconnect without a status", jsonx.Record{"responseStreamDisconnected": jsonx.Record{"httpStatusCode": nil}}, "", `{"failure":"unknown"}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			turnError := jsonx.ParseRecord(raw(t, jsonx.Record{"message": testCase.message, "codexErrorInfo": testCase.info}))
			expected := jsonx.ParseRecord([]byte(testCase.expected))
			expected["kind"] = "failed"
			expected["reason"] = "failed: x"
			sameJSON(t, codexFailure("failed: x", turnError), jsonText(expected))
		})
	}
}
