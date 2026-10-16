package codex

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
)

// Ports tests/codex-account-usage-reader.test.ts and the codex part of tests/account-usage.test.ts.

// scriptedClient is an appServerClient answering requests with answer.
type scriptedClient struct {
	mu     sync.Mutex
	calls  []string
	answer func(method string) (jsonx.Record, error)
}

func (c *scriptedClient) record(method string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, method)
}

func (c *scriptedClient) spawned(context.Context) error { return nil }
func (c *scriptedClient) exited() <-chan struct{}       { return closedChannel }
func (c *scriptedClient) request(_ context.Context, method string, _ any, onSettled func(rpcOutcome)) (rpcResult, error) {
	c.record(method)
	result, err := c.answer(method)
	if err != nil {
		return rpcResult{}, err
	}
	return rpcResult{record: result, raw: []byte(jsonText(result))}, nil
}
func (c *scriptedClient) notify(method string, _ any)      { c.record(method) }
func (c *scriptedClient) handle(appServerHandlers) error   { return nil }
func (c *scriptedClient) mark(callback func())             { callback() }
func (c *scriptedClient) onExit(func(*int))                {}
func (c *scriptedClient) kill()                            {}
func (c *scriptedClient) resources() *executable.Resources { return nil }

func readWith(t *testing.T, answer func(method string) (jsonx.Record, error)) (readOutcome, []string) {
	client := &scriptedClient{answer: answer}
	outcome := readFromAppServer(context.Background(), "codex", time.Second, func(string) appServerClient { return client })
	return outcome, client.calls
}

func outcomeJSON(outcome readOutcome) map[string]any {
	out := map[string]any{"kind": outcome.kind}
	if outcome.reason != "" {
		out["reason"] = outcome.reason
	}
	if outcome.kind == "ok" {
		out["result"] = outcome.result
		if outcome.email != "" {
			out["email"] = outcome.email
		}
	}
	return out
}

func TestDetectsValidNonSubscriptionAccountModes(t *testing.T) {
	for _, testCase := range []struct {
		value string
		want  bool
	}{
		{`{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}`, true},
		{`{"account":null,"requiresOpenaiAuth":false}`, true},
		{`{"account":{"type":"chatgpt","email":"person@example.com"},"requiresOpenaiAuth":true}`, false},
		{`{"account":{"type":"future-mode"},"requiresOpenaiAuth":true}`, false},
	} {
		if got := isNonSubscriptionAccount(jsonx.ParseRecord([]byte(testCase.value))); got != testCase.want {
			t.Fatalf("%s: %v", testCase.value, got)
		}
	}
}

func unexpected(method string) error { return errors.New("unexpected request: " + method) }

func TestAPIKeyModeIsUnsupportedUsageRatherThanExpiredAuth(t *testing.T) {
	for _, account := range []string{`{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}`, `{"account":null,"requiresOpenaiAuth":false}`} {
		outcome, calls := readWith(t, func(method string) (jsonx.Record, error) {
			switch method {
			case "initialize":
				return jsonx.Record{}, nil
			case "account/read":
				return jsonx.ParseRecord([]byte(account)), nil
			}
			return nil, unexpected(method)
		})
		sameJSON(t, outcomeJSON(outcome), `{"kind":"unsupported","reason":"unsupported_auth_mode"}`)
		sameJSON(t, calls, `["initialize","initialized","account/read"]`)
	}
}

func TestMissingChatGPTAuthRemainsReauthRequired(t *testing.T) {
	outcome, calls := readWith(t, func(method string) (jsonx.Record, error) {
		switch method {
		case "initialize":
			return jsonx.Record{}, nil
		case "account/read":
			return jsonx.ParseRecord([]byte(`{"account":null,"requiresOpenaiAuth":true}`)), nil
		}
		return nil, errors.New("codex account authentication required to read rate limits")
	})
	sameJSON(t, outcomeJSON(outcome), `{"kind":"reauth_required","reason":"not_authenticated"}`)
	sameJSON(t, calls, `["initialize","initialized","account/read","account/rateLimits/read"]`)
}

func TestChatGPTModeKeepsSubscriptionWindowsAndAccountEmail(t *testing.T) {
	rateLimits := jsonx.ParseRecord([]byte(`{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300}}}`))
	outcome, calls := readWith(t, func(method string) (jsonx.Record, error) {
		switch method {
		case "initialize":
			return jsonx.Record{}, nil
		case "account/read":
			return jsonx.ParseRecord([]byte(`{"account":{"type":"chatgpt","email":"person@example.com","planType":"pro"},"requiresOpenaiAuth":true}`)), nil
		case "account/rateLimits/read":
			return rateLimits, nil
		}
		return nil, unexpected(method)
	})
	sameJSON(t, outcomeJSON(outcome), `{"kind":"ok","result":`+jsonText(rateLimits)+`,"email":"person@example.com"}`)
	sameJSON(t, calls, `["initialize","initialized","account/read","account/rateLimits/read"]`)
}

func TestOlderAppServerCanStillReturnSubscriptionWindows(t *testing.T) {
	rateLimits := jsonx.ParseRecord([]byte(`{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300}}}`))
	outcome, calls := readWith(t, func(method string) (jsonx.Record, error) {
		switch method {
		case "initialize":
			return jsonx.Record{}, nil
		case "account/read":
			return nil, errors.New("method not found")
		case "account/rateLimits/read":
			return rateLimits, nil
		}
		return nil, unexpected(method)
	})
	sameJSON(t, outcomeJSON(outcome), `{"kind":"ok","result":`+jsonText(rateLimits)+`}`)
	sameJSON(t, calls, `["initialize","initialized","account/read","account/rateLimits/read"]`)
}

func TestDistinguishesMissingUsageEndpointFromUnsupportedAuthMode(t *testing.T) {
	outcome, _ := readWith(t, func(method string) (jsonx.Record, error) {
		switch method {
		case "initialize":
			return jsonx.Record{}, nil
		case "account/read":
			return jsonx.ParseRecord([]byte(`{"account":{"type":"chatgpt"}}`)), nil
		}
		return nil, errors.New("method not found")
	})
	sameJSON(t, outcomeJSON(outcome), `{"kind":"unsupported","reason":"endpoint_unavailable"}`)
}

func projectUsage(t *testing.T, payload, email string) any {
	snapshot, err := ProjectCodexUsage([]byte(payload), email)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestProjectionPreservesTypedRateLimitWindows(t *testing.T) {
	sameJSON(t, projectUsage(t, `{"rateLimits":{"planType":"plus","primary":{"usedPercent":25,"resetsAt":1800000000,"windowDurationMins":300}}}`, ""),
		`{"kind":"available","plan":"plus","rateLimited":false,"windows":[{"durationMs":18000000,"label":"5 hours","resetsAt":"2027-01-15T08:00:00.000Z","usedRatio":0.25}]}`)
}

const separateLimits = `{
	"rateLimits": {"limitId": "codex", "limitName": null, "planType": "pro", "primary": {"usedPercent": 92, "resetsAt": 1800200000, "windowDurationMins": 10080}, "secondary": null},
	"rateLimitsByLimitId": {
		"codex_bengalfox": {"limitId": "codex_bengalfox", "limitName": "GPT-5.3-Codex-Spark", "planType": "pro", "primary": {"usedPercent": 0, "resetsAt": 1800000000, "windowDurationMins": 300}, "secondary": {"usedPercent": 0, "resetsAt": 1800100000, "windowDurationMins": 10080}},
		"codex": {"limitId": "codex", "limitName": null, "planType": "pro", "primary": {"usedPercent": 99, "resetsAt": 1800200000, "windowDurationMins": 10080}, "secondary": null}
	}
}`

func TestProjectionDistinguishesWindowsFromSeparateLimits(t *testing.T) {
	sameJSON(t, projectUsage(t, separateLimits, ""), `{"kind":"available","plan":"pro","rateLimited":false,"windows":[
		{"durationMs":604800000,"id":"codex:primary","label":"Codex · 1 week","resetsAt":"2027-01-17T15:33:20.000Z","usedRatio":0.92},
		{"durationMs":18000000,"id":"codex_bengalfox:primary","label":"GPT-5.3-Codex-Spark · 5 hours","resetsAt":"2027-01-15T08:00:00.000Z","usedRatio":0},
		{"durationMs":604800000,"id":"codex_bengalfox:secondary","label":"GPT-5.3-Codex-Spark · 1 week","resetsAt":"2027-01-16T11:46:40.000Z","usedRatio":0}]}`)
}

func TestProjectionMergesAnExtraOnlyIndexedView(t *testing.T) {
	sameJSON(t, projectUsage(t, `{"rateLimits":{"planType":"pro","primary":{"usedPercent":50,"resetsAt":1800000000,"windowDurationMins":10080},"secondary":null},
		"rateLimitsByLimitId":{"codex_bengalfox":{"limitName":"GPT-5.3-Codex-Spark","planType":"pro","primary":{"usedPercent":0,"resetsAt":1800100000,"windowDurationMins":300},"secondary":null}}}`, ""),
		`{"kind":"available","plan":"pro","rateLimited":false,"windows":[
		{"durationMs":604800000,"label":"1 week","resetsAt":"2027-01-15T08:00:00.000Z","usedRatio":0.5},
		{"durationMs":18000000,"label":"GPT-5.3-Codex-Spark · 5 hours","resetsAt":"2027-01-16T11:46:40.000Z","usedRatio":0}]}`)
}

func TestProjectionIncludesTheAccountEmailWhenSupplied(t *testing.T) {
	matchJSON(t, projectUsage(t, `{"rateLimits":{"planType":"pro","primary":{"usedPercent":10,"windowDurationMins":300}}}`, "person@example.com"), `{"kind":"available","plan":"pro","email":"person@example.com"}`)
}

func TestAccountEmailAcceptsOnlyAChatGPTAccount(t *testing.T) {
	for _, testCase := range []struct{ value, want string }{
		{`{"account":{"type":"chatgpt","email":"person@example.com"}}`, "person@example.com"},
		{`{"account":{"type":"apiKey","email":"person@example.com"}}`, ""},
		{`{"account":{"type":"chatgpt","email":42}}`, ""},
		{`{}`, ""},
	} {
		if got := accountEmail(jsonx.ParseRecord([]byte(testCase.value))); got != testCase.want {
			t.Fatalf("%s: %q", testCase.value, got)
		}
	}
}
