package pi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ported from tests/replay/pi-projection.test.ts and tests/pi/*.test.ts.

func fold(state ProjectionState, event string) (ProjectionState, []oar.EventBody) {
	native := json.RawMessage(event)
	next, frame := FoldEvent(state, native, jsonx.ParseRecord(native), FoldExtra{Overflow: OverflowOf(jsonx.ParseRecord(native))})
	return next, frame.Events
}

func eventsJSON(t *testing.T, events []oar.EventBody) any {
	t.Helper()
	if events == nil {
		events = []oar.EventBody{}
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	var value any
	_ = json.Unmarshal(encoded, &value)
	return value
}

func wantJSON(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func expectEvents(t *testing.T, events []oar.EventBody, want string) {
	t.Helper()
	if got := eventsJSON(t, events); !reflect.DeepEqual(got, wantJSON(t, want)) {
		encoded, _ := json.Marshal(got)
		t.Fatalf("events = %s\nwant     %s", encoded, want)
	}
}

func describeEvent(event oar.EventBody) string {
	switch e := event.(type) {
	case oar.ToolCallStarted:
		return "tool_call_started " + e.Tool
	case oar.Reasoning:
		return "reasoning " + e.Content.Kind
	case oar.TurnEnded:
		return "turn_ended " + e.Outcome.Kind
	case oar.Usage:
		tokens := e.Usage.Tokens
		if tokens == nil {
			return "usage"
		}
		text := fmt.Sprintf("usage in=%d out=%d", tokens.Input, tokens.Output)
		if tokens.CacheRead != nil {
			text += fmt.Sprintf(" cacheRead=%d", *tokens.CacheRead)
		}
		if tokens.CacheWrite != nil {
			text += fmt.Sprintf(" cacheWrite=%d", *tokens.CacheWrite)
		}
		return text
	}
	return event.EventKind()
}

func TestRecordedPiEventsFoldToTheSnapshots(t *testing.T) {
	for _, scenario := range []string{"tool-round", "mcp-echo"} {
		t.Run(scenario, func(t *testing.T) {
			fixtures := filepath.Join("..", "..", "testdata", "replay", "fixtures")
			raw, err := os.ReadFile(filepath.Join(fixtures, "pi-"+scenario+".raw.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(filepath.Join(fixtures, "pi-"+scenario+".projected.txt"))
			if err != nil {
				t.Fatal(err)
			}
			state := Prompted(ProjectionState{})
			var rows []string
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.TrimSpace(line) == "" {
					continue
				}
				var events []oar.EventBody
				state, events = fold(state, line)
				parts := make([]string, 0, len(events))
				for _, event := range events {
					parts = append(parts, describeEvent(event))
				}
				produced := "event"
				if len(parts) > 0 {
					produced += " → " + strings.Join(parts, ", ")
				}
				record := jsonx.ParseRecord([]byte(line))
				label := jsonx.Str(record, "type")
				if label == "message_update" {
					label += ":" + jsonx.Str(jsonx.AsRecord(record["assistantMessageEvent"]), "type")
				}
				rows = append(rows, fmt.Sprintf("%-30s │ %s", label, produced))
			}
			if got := strings.Join(rows, "\n") + "\n"; got != string(want) {
				t.Fatalf("projection differs from the snapshot:\n%s", got)
			}
		})
	}
}

func TestSettledCarriesContextAndClassifiesAbortAndProviderErrors(t *testing.T) {
	tokens, window, percent := int64(42), int64(1000), 4.0
	context := &oar.ContextUsage{Tokens: &tokens, ContextWindow: &window, Percent: &percent}
	native := json.RawMessage(`{"type":"agent_settled","aborted":false}`)
	_, frame := FoldEvent(Prompted(ProjectionState{}), native, jsonx.ParseRecord(native), FoldExtra{Context: context})
	expectEvents(t, frame.Events, `[{"kind":"turn_ended","outcome":{"kind":"completed"}},{"kind":"usage","usage":{"context":{"tokens":42,"contextWindow":1000,"percent":4}}}]`)
	_, aborted := fold(Prompted(ProjectionState{}), `{"type":"agent_settled","aborted":true}`)
	expectEvents(t, aborted, `[{"kind":"turn_ended","outcome":{"kind":"aborted"}}]`)
	errored, _ := fold(Prompted(ProjectionState{}), `{"type":"turn_end","message":{"role":"assistant","stopReason":"error","errorMessage":"400 bad request"},"toolResults":[]}`)
	_, ended := fold(errored, `{"type":"agent_settled","aborted":false}`)
	expectEvents(t, ended[:1], `[{"kind":"turn_ended","outcome":{"kind":"failed","reason":"400 bad request","failure":"invalid_request","status":400}}]`)
}

func TestNativeAbortedFlagWinsOverAbortError(t *testing.T) {
	failed, _ := fold(ProjectionState{}, `{"type":"turn_end","message":{"role":"assistant","stopReason":"error","errorMessage":"This operation was aborted"},"toolResults":[]}`)
	_, events := fold(failed, `{"type":"agent_settled","aborted":true}`)
	expectEvents(t, events, `[{"kind":"turn_ended","outcome":{"kind":"aborted"}}]`)
}

func assistantEnd(input, output, cacheRead, cacheWrite int, extra string) string {
	return fmt.Sprintf(`{"type":"message_end","message":{"role":"assistant","usage":{"input":%d,"output":%d,"cacheRead":%d,"cacheWrite":%d%s}}}`, input, output, cacheRead, cacheWrite, extra)
}

func TestReasoningAccumulatesOnlyWhenReported(t *testing.T) {
	state := ProjectionState{}
	state, _ = fold(state, assistantEnd(10, 5, 0, 0, `,"reasoning":3`))
	state, _ = fold(state, assistantEnd(20, 4, 0, 0, ""))
	state, _ = fold(state, assistantEnd(30, 8, 0, 0, `,"reasoning":0`))
	encoded, _ := json.Marshal(state.Tokens)
	if !reflect.DeepEqual(wantJSON(t, string(encoded)), wantJSON(t, `{"input":60,"output":17,"cacheRead":0,"cacheWrite":0,"reasoning":3}`)) {
		t.Fatalf("tokens = %s", encoded)
	}
}

func TestCacheAccumulatesAcrossTurnsAsPartsOfInput(t *testing.T) {
	state := Prompted(ProjectionState{})
	var totals []oar.EventBody
	for _, event := range []string{assistantEnd(1381, 39, 0, 5120, `,"cacheWrite1h":5120`), `{"type":"agent_settled","aborted":false}`, assistantEnd(12, 40, 5120, 1395, "")} {
		var events []oar.EventBody
		state, events = fold(state, event)
		for _, body := range events {
			if usage, ok := body.(oar.Usage); ok && usage.Usage.Tokens != nil {
				totals = append(totals, body)
			}
		}
	}
	expectEvents(t, totals, `[{"kind":"usage","usage":{"tokens":{"input":6501,"output":39,"cacheRead":0,"cacheWrite":5120}}},{"kind":"usage","usage":{"tokens":{"input":13028,"output":79,"cacheRead":5120,"cacheWrite":6515}}}]`)
}

func TestToolEndMapsIsErrorAndContent(t *testing.T) {
	cases := []struct{ event, want string }{
		{`{"type":"tool_execution_end","toolCallId":"tool-fail","toolName":"bash","result":"boom","isError":true}`, `[{"kind":"tool_call_ended","callId":"tool-fail","content":[{"type":"text","text":"boom"}],"result":"failed"}]`},
		{`{"type":"tool_execution_end","toolCallId":"tool-success","toolName":"bash","result":"boom","isError":false}`, `[{"kind":"tool_call_ended","callId":"tool-success","content":[{"type":"text","text":"boom"}],"result":"ok"}]`},
		{`{"type":"tool_execution_end","toolCallId":"call_edit","toolName":"edit","result":{"content":[{"type":"text","text":"Successfully replaced 1 block(s) in math.js."}],"details":{"patch":"--- math.js"}},"isError":false}`, `[{"kind":"tool_call_ended","callId":"call_edit","content":[{"type":"text","text":"Successfully replaced 1 block(s) in math.js."}],"result":"ok"}]`},
		{`{"type":"tool_execution_end","toolCallId":"call_read","toolName":"read","result":{"content":[{"type":"text","text":"a"},{"type":"image","data":"…","mimeType":"image/png"},{"type":"text","text":"b"}]},"isError":false}`, `[{"kind":"tool_call_ended","callId":"call_read","content":[{"type":"text","text":"a"},{"type":"image","mediaType":"image/png","data":"…"},{"type":"text","text":"b"}],"result":"ok"}]`},
		{`{"type":"tool_execution_end","toolCallId":"call_custom","toolName":"custom","result":{"content":[{"type":"resource","uri":"file:///x"}]},"isError":false}`, `[{"kind":"tool_call_ended","callId":"call_custom","content":[{"type":"other","value":{"type":"resource","uri":"file:///x"}}],"result":"ok"}]`},
		{`{"type":"tool_execution_end","toolCallId":"call_bare","toolName":"bare","result":{"details":{"n":1}},"isError":false}`, `[{"kind":"tool_call_ended","callId":"call_bare","content":[{"type":"other","value":{"details":{"n":1}}}],"result":"ok"}]`},
	}
	for _, c := range cases {
		_, events := fold(ProjectionState{}, c.event)
		expectEvents(t, events, c.want)
	}
}

func TestCompactionRetryAndProgress(t *testing.T) {
	state := Prompted(ProjectionState{})
	_, started := fold(state, `{"type":"compaction_start","reason":"threshold"}`)
	expectEvents(t, started, `[{"kind":"compaction_started","trigger":"threshold"}]`)
	_, failed := fold(state, `{"type":"compaction_end","reason":"threshold","aborted":false,"willRetry":true,"errorMessage":"summary call failed"}`)
	expectEvents(t, failed, `[{"kind":"compaction_ended","outcome":"failed","reason":"summary call failed","trigger":"threshold"}]`)
	_, aborted := fold(state, `{"type":"compaction_end","reason":"manual","aborted":true,"willRetry":false}`)
	expectEvents(t, aborted, `[{"kind":"compaction_ended","outcome":"aborted","trigger":"manual"}]`)
	_, retry := fold(state, `{"type":"auto_retry_start","attempt":2,"maxAttempts":3,"delayMs":1500,"errorMessage":"overloaded"}`)
	expectEvents(t, retry, `[{"attempt":2,"delayMs":1500,"kind":"retry","maxAttempts":3,"reason":"overloaded"}]`)
	_, progress := fold(state, `{"type":"tool_execution_update","toolCallId":"call_1","toolName":"bash","args":{},"partialResult":{"content":[{"type":"text","text":"half"}],"details":{}}}`)
	expectEvents(t, progress, `[{"callId":"call_1","kind":"tool_call_progress","output":"{\"content\":[{\"type\":\"text\",\"text\":\"half\"}],\"details\":{}}"}]`)
}

func TestThinkingLevelChangedIsPisOwnReport(t *testing.T) {
	_, events := fold(ProjectionState{}, `{"type":"thinking_level_changed","level":"high"}`)
	expectEvents(t, events, `[{"kind":"effort","effort":"high"}]`)
}

func TestOverflowClassifiesInputTooLarge(t *testing.T) {
	errored, _ := fold(ProjectionState{}, `{"type":"turn_end","message":{"role":"assistant","stopReason":"error","errorMessage":"400 prompt is too long: 210000 tokens > 200000 maximum"}}`)
	_, events := fold(errored, `{"type":"agent_settled","aborted":false}`)
	expectEvents(t, events, `[{"kind":"turn_ended","outcome":{"kind":"failed","reason":"400 prompt is too long: 210000 tokens > 200000 maximum","failure":"input_too_large","status":400}}]`)
	if IsContextOverflow(map[string]any{"stopReason": "error", "errorMessage": "429 rate limit: too many tokens"}) {
		t.Fatal("a rate limit is never an overflow")
	}
}

func TestThinkingLevelsAndModelIDs(t *testing.T) {
	if level, err := ThinkingLevel("high"); err != nil || level != "high" {
		t.Fatal(level, err)
	}
	if _, err := ThinkingLevel("extreme"); err == nil || err.Error() != "pi has no thinking level extreme (pi's levels: off, minimal, low, medium, high, xhigh, max)" {
		t.Fatal(err)
	}
	if provider, model, err := SplitModelID("openrouter/anthropic/claude"); err != nil || provider != "openrouter" || model != "anthropic/claude" {
		t.Fatal(provider, model, err)
	}
	if _, _, err := SplitModelID("sonnet"); err == nil || !strings.Contains(err.Error(), `pi model must be spelled provider/model as listed by `+"`oar models pi`"+`; got "sonnet"`) {
		t.Fatal(err)
	}
	levels := SupportedThinkingLevels(jsonx.Record{"reasoning": true, "thinkingLevelMap": map[string]any{"minimal": nil, "xhigh": "x"}})
	if strings.Join(levels, ",") != "off,low,medium,high,xhigh" {
		t.Fatal(levels)
	}
	if got := SupportedThinkingLevels(jsonx.Record{"reasoning": false}); strings.Join(got, ",") != "off" {
		t.Fatal(got)
	}
}

func TestSessionDirAndFindSessionFile(t *testing.T) {
	if got := SessionDir("/home/me/proj", "/home/me/.pi/agent"); got != filepath.Join("/home/me/.pi/agent", "sessions", "--home-me-proj--") {
		t.Fatal(got)
	}
	agentDir := t.TempDir()
	cwd := t.TempDir()
	dir := SessionDir(cwd, agentDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "a.jsonl"), []byte(`{"type":"session","version":3,"id":"other"}`+"\n"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "b.jsonl"), []byte(`{"type":"session","version":3,"id":"abc-123"}`+"\n{}\n"), 0o600)
	if file, err := FindSessionFile("abc-123", cwd, agentDir); err != nil || file != filepath.Join(dir, "b.jsonl") {
		t.Fatal(file, err)
	}
	_, err := FindSessionFile("missing-id", cwd, agentDir)
	notFound, ok := err.(*oar.SessionNotFoundError)
	if !ok || notFound.SessionID != "missing-id" || !strings.Contains(notFound.Message, "pi session missing-id not found: no session file with that id under "+dir+" (2 session(s) there for cwd "+cwd+"; pi persists a session on its first message)") {
		t.Fatal(err)
	}
}

func TestMCPServerConfigsAreLiteral(t *testing.T) {
	for value, want := range map[string]string{"!echo pwned": "$!echo pwned", "$HOME": "$$HOME", "a$$b": "a$$$$b", "plain-token": "plain-token"} {
		if got := LiteralConfigValue(value); got != want {
			t.Fatalf("%q → %q", value, got)
		}
	}
	shared := "session"
	stdio, err := MCPServerConfig(oar.McpServer{Name: "echo", Command: "node", Args: []string{"server.mjs"}, Env: map[string]string{"TOKEN": "!secret", "SHARED": "entry"}}, map[string]*string{"SHARED": &shared, "DEPTH": oar.String("1")})
	if err != nil {
		t.Fatal(err)
	}
	expectJSON(t, stdio, `{"type":"stdio","command":"node","args":["server.mjs"],"env":{"SHARED":"entry","DEPTH":"1","TOKEN":"$!secret"},"exposure":"direct"}`)
	bare, _ := MCPServerConfig(oar.McpServer{Name: "echo", Command: "node"}, nil)
	expectJSON(t, bare, `{"type":"stdio","command":"node","args":[],"exposure":"direct"}`)
	http, _ := MCPServerConfig(oar.McpServer{Name: "remote", Type: "http", URL: "http://127.0.0.1:1/mcp", Headers: map[string]string{"Authorization": "Bearer $x"}}, nil)
	expectJSON(t, http, `{"type":"http","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer $$x"},"exposure":"direct"}`)
	names := func(list ...string) []oar.McpServer {
		servers := make([]oar.McpServer, 0, len(list))
		for _, name := range list {
			servers = append(servers, oar.McpServer{Name: name, Command: "node"})
		}
		return servers
	}
	for _, c := range []struct {
		servers []oar.McpServer
		want    string
	}{
		{names("my server"), `pi registers no MCP server named "my server"`},
		{names("a-b", "a_b"), `pi would give the MCP servers "a-b" and "a_b" one tool namespace (mcp__a_b)`},
		{names("echo", "echo"), `mcpServers names "echo" twice`},
	} {
		if err := checkMCPServerNames(c.servers); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Fatalf("%v: %v", c.servers, err)
		}
	}
	if _, err := MCPServerConfig(oar.McpServer{Name: "echo", Command: "node"}, map[string]*string{"GONE": nil}); err == nil {
		t.Fatal("an env removal with a stdio server must be refused")
	}
}

func expectJSON(t *testing.T, value any, want string) {
	t.Helper()
	encoded, _ := json.Marshal(value)
	if !reflect.DeepEqual(wantJSON(t, string(encoded)), wantJSON(t, want)) {
		t.Fatalf("got %s\nwant %s", encoded, want)
	}
}
