package codex

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports the pure parts of tests/codex/codex-session-mcp-servers.test.ts,
// codex-session-effort.test.ts, codex-service-tier.test.ts,
// codex-disallowed-tools.test.ts and the codex part of
// tests/additional-directories.test.ts.

const stdioToken = "stdio-secret-value"
const headerSecret = "Bearer header-secret-value"

var echoServer = oar.McpServer{Name: "echo", Command: "/usr/bin/node", Args: []string{"echo.mjs"}, Env: map[string]string{"OAR_ECHO_TOKEN": stdioToken}}
var remoteServer = oar.McpServer{Name: "remote.v2", Type: "http", URL: "http://127.0.0.1:9/mcp", Headers: map[string]string{"Authorization": headerSecret}}

func mustThreadOpen(t *testing.T, options oar.SessionOptions) codexThreadOpenRequest {
	t.Helper()
	open, err := codexThreadOpen(options)
	if err != nil {
		t.Fatal(err)
	}
	return open
}

func TestThreadStartAndThreadResumeBothCarryTheServersAsOneMcpServersConfigTable(t *testing.T) {
	start := mustThreadOpen(t, oar.SessionOptions{Cwd: "/work", Effort: "low", MCPServers: []oar.McpServer{echoServer, remoteServer, {Name: "bare", Command: "bare-server"}}})
	sameJSON(t, start.Params["config"], `{
		"mcp_servers": {
			"bare": {"args": [], "command": "bare-server", "enabled": true},
			"echo": {"args": ["echo.mjs"], "command": "/usr/bin/node", "enabled": true, "env": {"OAR_ECHO_TOKEN": "stdio-secret-value"}},
			"remote.v2": {"enabled": true, "http_headers": {"Authorization": "Bearer header-secret-value"}, "url": "http://127.0.0.1:9/mcp"}
		},
		"model_reasoning_effort": "low"
	}`)
	// A resume takes no effort override (open.go) but the servers again.
	resume := mustThreadOpen(t, oar.SessionOptions{Cwd: "/work", Resume: "thread-1", Effort: "low", MCPServers: []oar.McpServer{echoServer}})
	if resume.Method != methodThreadResume {
		t.Fatalf("method %s", resume.Method)
	}
	if keys := sortedKeys(jsonx.AsRecord(resume.Params["config"])); strings.Join(keys, ",") != "mcp_servers" {
		t.Fatalf("resume config keys %v", keys)
	}
	// None given, or an empty list: no config at all.
	if _, ok := mustThreadOpen(t, oar.SessionOptions{Cwd: "/work", MCPServers: []oar.McpServer{}}).Params["config"]; ok {
		t.Fatal("an empty list made a config")
	}
	if _, ok := mustThreadOpen(t, oar.SessionOptions{Cwd: "/work", Resume: "thread-1"}).Params["config"]; ok {
		t.Fatal("a resume without servers made a config")
	}
}

func TestCodexSetsAndConfirmsWorkspaceRootsWithoutChangingPermissionConfig(t *testing.T) {
	cwd, _ := filepath.Abs("project")
	extra := filepath.Join(filepath.Dir(cwd), "extra directory")
	for _, resume := range []string{"", "old-thread"} {
		options := oar.SessionOptions{Cwd: cwd, AdditionalDirectories: []string{"../extra directory", "."}, Resume: resume}
		open := mustThreadOpen(t, options)
		sameJSON(t, open.Params["runtimeWorkspaceRoots"], jsonText([]string{cwd, extra}))
		for _, key := range []string{"config", "sandbox"} {
			if _, ok := open.Params[key]; ok {
				t.Fatalf("params carry %s", key)
			}
		}
		if _, refusal, _ := codexOpenReadback(open.Method, options, jsonx.Record{"runtimeWorkspaceRoots": []any{cwd, extra}}); refusal != "" {
			t.Fatal(refusal)
		}
		// A loaded native thread can ignore the override; never accept that reply.
		if _, refusal, _ := codexOpenReadback(open.Method, options, jsonx.Record{"runtimeWorkspaceRoots": []any{cwd}}); !strings.Contains(refusal, "did not confirm") {
			t.Fatalf("refusal %q", refusal)
		}
		if _, refusal, _ := codexOpenReadback(open.Method, options, jsonx.Record{}); !strings.Contains(refusal, "did not confirm") {
			t.Fatalf("refusal %q", refusal)
		}
	}
	if _, ok := mustThreadOpen(t, oar.SessionOptions{Cwd: cwd, AdditionalDirectories: []string{}}).Params["runtimeWorkspaceRoots"]; ok {
		t.Fatal("an empty list set workspace roots")
	}
}

func TestResumeEffortRefusalRefusesAResumeCodexNeverConfirms(t *testing.T) {
	if refusal := codexResumeEffortRefusal("low", nil, jsonx.Record{"threadSettings": jsonx.Record{"effort": "low"}}); refusal != "" {
		t.Fatal(refusal)
	}
	if refusal := codexResumeEffortRefusal("low", nil, nil); refusal != "codex reported no thread/settings/updated within 10000 ms, so effort low cannot be confirmed" {
		t.Fatal(refusal)
	}
}

func TestThreadSettingsUpdatedIsCodexsOwnReportOfTheModelAndEffortASettingsChangeSet(t *testing.T) {
	params := jsonx.Record{"threadId": "thread-123", "threadSettings": jsonx.Record{"cwd": "/work", "model": "gpt-5.5", "modelProvider": "openai", "effort": "low", "summary": nil}}
	_, commands := fold(t, initialCodexProjection("thread-123", methodThreadStart), "thread/settings/updated", params)
	if len(commands) != 1 || commands[0].Kind != "frame" || commands[0].SpanID != "" || commands[0].SessionID != "" {
		t.Fatalf("commands %+v", commands)
	}
	sameJSON(t, commands[0].Body, `{"type":"thread/settings/updated","native":`+jsonText(params)+`,"events":[{"kind":"model","model":"gpt-5.5"},{"kind":"effort","effort":"low"}]}`)
	_, cleared := fold(t, initialCodexProjection("thread-123", methodThreadStart), "thread/settings/updated", jsonx.Record{"threadId": "thread-123", "threadSettings": jsonx.Record{"model": "gpt-5.5", "effort": nil}})
	sameJSON(t, cleared[0].Body.Events, `[{"kind":"model","model":"gpt-5.5"}]`)
}

func TestSettingsNotificationsPreserveATierChangeAndExplicitRemoval(t *testing.T) {
	for _, testCase := range []struct {
		native   any
		reported string
	}{{"flex", "flex"}, {nil, "default"}} {
		params := jsonx.Record{"threadId": "tier-thread", "threadSettings": jsonx.Record{"serviceTier": testCase.native}}
		_, commands := fold(t, initialCodexProjection("tier-thread", methodThreadStart), "thread/settings/updated", params)
		sameJSON(t, commands[0].Body, `{"type":"thread/settings/updated","native":`+jsonText(params)+`,"events":[{"kind":"service_tier","serviceTier":"`+testCase.reported+`"}]}`)
	}
}

func TestMcpDenialsUnionWithNativeFiltersAndDoNotCopyCredentialsOrOtherServerSettings(t *testing.T) {
	effective := jsonx.ParseRecord([]byte(`{"mcp_servers":{"echo":{"command":"private-command","env":{"KEY":"secret"},"disabled_tools":["prior"]}}}`))
	options := oar.SessionOptions{Cwd: "/tmp", DisallowedTools: []string{"mcp__echo__echo", "mcp__echo__prior"}}
	filters, err := codexToolDenialsConfig(options, effective)
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, filters, `{"echo":{"disabled_tools":["prior","echo"]}}`)
	sameJSON(t, effective, `{"mcp_servers":{"echo":{"command":"private-command","env":{"KEY":"secret"},"disabled_tools":["prior"]}}}`)
	params := jsonx.ParseRecord([]byte(`{"model":"m","config":{"model_reasoning_effort":"high","mcp_servers":{"echo":{"command":"session-command","args":["arg"]},"other":{"url":"https://example.invalid"}}}}`))
	sameJSON(t, withCodexToolDenials(params, filters), `{"model":"m","config":{"model_reasoning_effort":"high","mcp_servers":{"echo":{"command":"session-command","args":["arg"],"disabled_tools":["prior","echo"]},"other":{"url":"https://example.invalid"}}}}`)
}

func TestSessionOnlyServersResolveUnknownOrAmbiguousNamespacesAreExplicitlyRefused(t *testing.T) {
	filters, err := codexToolDenialsConfig(oar.SessionOptions{Cwd: "/tmp", MCPServers: []oar.McpServer{{Name: "echo", Command: "node"}}, DisallowedTools: []string{"mcp__echo__a"}}, jsonx.Record{})
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, filters, `{"echo":{"disabled_tools":["a"]}}`)
	if _, err := codexToolDenialsConfig(oar.SessionOptions{Cwd: "/tmp", DisallowedTools: []string{"mcp__absent__a"}}, jsonx.Record{}); err == nil || !strings.Contains(err.Error(), "mcp__absent__a") {
		t.Fatalf("err %v", err)
	}
	if _, err := codexToolDenialsConfig(oar.SessionOptions{Cwd: "/tmp", DisallowedTools: []string{"mcp__a__b__tool"}}, jsonx.ParseRecord([]byte(`{"mcp_servers":{"a":{},"a__b":{}}}`))); err == nil || !strings.Contains(err.Error(), "cannot identify one") {
		t.Fatalf("err %v", err)
	}
}

func TestBuiltinsAndUnqualifiedToolNamesRejectBeforeStartingAppServerIncludingMixedLists(t *testing.T) {
	spawner := useFakes(t, newFakeProcess(nil))
	_, err := Session(testContext(t), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent"}, oar.SessionOptions{Cwd: "/tmp", Resume: "old", DisallowedTools: []string{"mcp__echo__echo", "exec_command", "echo"}})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "disallowedTools" || !strings.Contains(err.Error(), `["exec_command","echo"]`) {
		t.Fatalf("err %v", err)
	}
	if spawner.count() != 0 {
		t.Fatal("app-server started")
	}
}
