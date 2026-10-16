package shared

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
)

func record(t *testing.T, text string) jsonx.Record {
	t.Helper()
	parsed := jsonx.ParseRecord([]byte(text))
	if parsed == nil {
		t.Fatalf("not an object: %s", text)
	}
	return parsed
}

func TestGrokNotificationsRedactOnlyCredentialValues(t *testing.T) {
	native := `{"sessionId":"session-1","name":"remote","status":"ready","connected":2,
		"env":{"API_KEY":"env-secret","PATH":"/bin"},
		"headers":[{"name":"Authorization","value":"header-secret","source":"user"}],
		"bearerToken":"bearer-secret","bearer_token_env_var":"TOKEN_NAME",
		"tools":[{"name":"sample","inputSchema":{"properties":{"input":{"type":"string"}}}}]}`
	for _, method := range []string{"_x.ai/mcp/servers_updated", "_x.ai/mcp/server_status", "_x.ai/mcp/init_progress", "_x.ai/mcp_initialized"} {
		params := record(t, native)
		before := record(t, native)
		jsonEqual(t, RedactGrokNotification(method, params), `{"sessionId":"session-1","name":"remote","status":"ready","connected":2,
			"env":{"API_KEY":"[redacted]","PATH":"[redacted]"},
			"headers":[{"name":"Authorization","value":"[redacted]","source":"user"}],
			"bearerToken":"[redacted]","bearer_token_env_var":"TOKEN_NAME",
			"tools":[{"name":"sample","inputSchema":{"properties":{"input":{"type":"string"}}}}]}`)
		if !reflect.DeepEqual(params, before) {
			t.Fatalf("%s changed the received object", method)
		}
	}
}

func TestGrokNestedCredentialsAreRedacted(t *testing.T) {
	native := `{"update":{"servers":[{"config":{
		"env":[{"name":"API_KEY","value":"nested-env-secret","source":"user"}],
		"transport":{"headers":{"Authorization":"nested-header-secret"},"http_headers":[{"name":"X-Key","value":"nested-http-secret"}]},
		"auth":[{"bearer_token":"nested-bearer-secret"},{"bearerToken":"nested-camel-secret"}],
		"command":"echo","args":["hello"],"enabled":true}}]},"revision":1}`
	params := record(t, native)
	before := record(t, native)
	redacted := RedactGrokNotification("_x.ai/mcp/servers_updated", params)
	jsonEqual(t, redacted, `{"update":{"servers":[{"config":{
		"env":[{"name":"API_KEY","value":"[redacted]","source":"user"}],
		"transport":{"headers":{"Authorization":"[redacted]"},"http_headers":[{"name":"X-Key","value":"[redacted]"}]},
		"auth":[{"bearer_token":"[redacted]"},{"bearerToken":"[redacted]"}],
		"command":"echo","args":["hello"],"enabled":true}}]},"revision":1}`)
	encoded, _ := json.Marshal(redacted)
	if strings.Contains(string(encoded), "nested-") {
		t.Fatalf("a secret survived: %s", encoded)
	}
	if !reflect.DeepEqual(params, before) {
		t.Fatal("the received object changed")
	}
}

func TestOtherNotificationsStayIntact(t *testing.T) {
	native := record(t, `{"sessionId":"s","update":{"env":{"EXAMPLE":"not a configuration"}}}`)
	if got := RedactGrokNotification("_x.ai/session_notification", native); reflect.ValueOf(got).Pointer() != reflect.ValueOf(native).Pointer() {
		t.Fatal("an uncovered notification is not returned as received")
	}
	jsonEqual(t, RedactGrokNotification("_x.ai/mcp/server_status", record(t, `{"sessionId":"s","status":"ready","detail":"connected","tools":null}`)),
		`{"sessionId":"s","status":"ready","detail":"connected","tools":null}`)
	jsonEqual(t, RedactGrokNotification("_x.ai/mcp/servers_updated", record(t, `{"mcpServers":[{"name":"remote","headers":{"Authorization":"secret"},"env":[],"bearer_token":null}]}`)),
		`{"mcpServers":[{"name":"remote","headers":{"Authorization":"[redacted]"},"env":[],"bearer_token":null}]}`)
	if !RedactionCovers("_x.ai/mcp/servers_updated") || RedactionCovers("_x.ai/session_notification") || RedactionRules.Version != 1 {
		t.Fatal("the rules changed")
	}
}
