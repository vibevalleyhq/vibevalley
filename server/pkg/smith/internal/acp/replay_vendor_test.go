package acp_test

// The recorded ACP vendor snapshots (tests/replay/fixtures/*-acp-v1*.vendor.json):
// ported from tests/acp/acp-vendor-snapshot.test.ts and the ACP half of
// tests/replay/tool-activity.test.ts, which observe's replay test leaves
// out because it needs the ACP projection.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/runtimes/grok"
	"vibevalley/pkg/smith/runtimes/kimi"
	"vibevalley/pkg/smith/runtimes/opencode"
)

const replayFixtures = "../../testdata/replay/fixtures"

func loadSnapshot(t *testing.T, name string) jsonx.Record {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(replayFixtures, name+".vendor.json"))
	if err != nil {
		t.Fatal(err)
	}
	snapshot := jsonx.ParseRecord(data)
	if snapshot == nil {
		t.Fatal("not an object")
	}
	return snapshot
}

func stringsOf(value any) []string {
	out := []string{}
	for _, item := range jsonx.AsList(value) {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func initializeResponse(snapshot jsonx.Record) jsonx.Record {
	initialize := jsonx.AsRecord(snapshot["initialize"])
	methods := []any{}
	for _, id := range stringsOf(initialize["authMethodIds"]) {
		methods = append(methods, map[string]any{"id": id})
	}
	response := jsonx.Record{"authMethods": methods}
	if preferred, ok := initialize["defaultAuthMethodId"].(string); ok {
		response["_meta"] = map[string]any{"defaultAuthMethodId": preferred}
	}
	return response
}

func sessionResponse(snapshot jsonx.Record) jsonx.Record {
	modes := []any{}
	for _, id := range stringsOf(jsonx.Get(snapshot, "sessionNew", "modeIds")) {
		modes = append(modes, map[string]any{"id": id})
	}
	return jsonx.Record{"modes": map[string]any{"availableModes": modes}}
}

func promptFacts(snapshot jsonx.Record, facts map[string]any) map[string]any {
	prompt := jsonx.AsRecord(snapshot["prompt"])
	requests := jsonx.AsList(prompt["terminalRequests"])
	methods := []any{}
	for _, request := range requests {
		methods = append(methods, jsonx.AsRecord(request)["method"])
	}
	var first any
	if len(requests) > 0 {
		first = requests[0]
	}
	tools := jsonx.AsList(prompt["tools"])
	var last any
	if len(tools) > 0 {
		last = tools[len(tools)-1]
	}
	facts["stopReason"] = prompt["stopReason"]
	facts["terminalMethods"] = methods
	facts["terminalCreateKeys"] = stringsOf(jsonx.AsRecord(first)["paramKeys"])
	facts["finalToolStatus"] = jsonx.AsRecord(last)["status"]
	return facts
}

func TestGrokACPv1SnapshotRemainsCompatibleWithItsPrivateProfile(t *testing.T) {
	snapshot := loadSnapshot(t, "grok-acp-v1")
	jsonEqual(t, promptFacts(snapshot, map[string]any{
		"runtime":                   snapshot["runtime"],
		"version":                   snapshot["version"],
		"auth":                      grok.SelectAuthMethod(initializeResponse(snapshot)),
		"shellCommandCompatibility": grok.Profile.TerminalShellCommand,
	}), `{
		"auth": "cached_token", "finalToolStatus": "completed", "runtime": "grok", "shellCommandCompatibility": true, "stopReason": "end_turn",
		"terminalCreateKeys": ["command", "cwd", "env", "outputByteLimit", "sessionId"],
		"terminalMethods": ["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"],
		"version": "grok 1.0.5 (5115b46bc9)"}`)
}

func TestKimiACPv1SnapshotRemainsCompatibleWithLoginAndYoloSelection(t *testing.T) {
	snapshot := loadSnapshot(t, "kimi-acp-v1")
	jsonEqual(t, promptFacts(snapshot, map[string]any{
		"runtime":                   snapshot["runtime"],
		"version":                   snapshot["version"],
		"auth":                      kimi.SelectAuthMethod(initializeResponse(snapshot)),
		"shellCommandCompatibility": kimi.Profile.TerminalShellCommand,
		"yolo":                      kimi.SupportsYolo(sessionResponse(snapshot)),
	}), `{
		"auth": "login", "finalToolStatus": "completed", "runtime": "kimi", "shellCommandCompatibility": false, "stopReason": "end_turn",
		"terminalCreateKeys": ["args", "command", "cwd", "env", "outputByteLimit", "sessionId"],
		"terminalMethods": ["terminal/create", "terminal/wait_for_exit", "terminal/output", "terminal/release"],
		"version": "0.38.0", "yolo": true}`)
}

func TestOpencodeACPv1SnapshotRunsItsOwnShellAndListsSessionsForTheResumeCheck(t *testing.T) {
	snapshot := loadSnapshot(t, "opencode-acp-v1")
	prompt := jsonx.AsRecord(snapshot["prompt"])
	methods := []any{}
	for _, request := range jsonx.AsList(prompt["terminalRequests"]) {
		methods = append(methods, jsonx.AsRecord(request)["method"])
	}
	tools := jsonx.AsList(prompt["tools"])
	if opencode.Profile.SelectAuthMethod != nil {
		t.Fatal("opencode selects an auth method")
	}
	jsonEqual(t, map[string]any{
		"runtime":               snapshot["runtime"],
		"version":               snapshot["version"],
		"sessionCapabilities":   stringsOf(jsonx.Get(snapshot, "initialize", "sessionCapabilities")),
		"configOptionIds":       stringsOf(jsonx.Get(snapshot, "sessionNew", "configOptionIds")),
		"resumeKeepsSessionCwd": opencode.Profile.ResumeKeepsSessionCwd,
		"permissionRequests":    prompt["permissionRequests"],
		"stopReason":            prompt["stopReason"],
		"terminalMethods":       methods,
		"finalToolStatus":       jsonx.AsRecord(tools[len(tools)-1])["status"],
	}, `{
		"configOptionIds": ["model", "mode"], "finalToolStatus": "completed", "permissionRequests": [], "resumeKeepsSessionCwd": true,
		"runtime": "opencode", "sessionCapabilities": ["close", "fork", "list", "resume"], "stopReason": "end_turn",
		"terminalMethods": [], "version": "1.18.30"}`)
}

// ─── tests/replay/tool-activity.test.ts, ACP half ──────────────────────────

type acpCall struct {
	Runtime string  `json:"runtime"`
	Tool    string  `json:"tool"`
	Started *string `json:"started,omitempty"`
	Input   *string `json:"input,omitempty"`
}

// recordedUpdate is the update the snapshot test builds, keys in its order:
// each recorded rawInput key holds its own name in brackets.
func recordedUpdate(t *testing.T, callID string, frame jsonx.Record) json.RawMessage {
	t.Helper()
	field := func(key string, value any) string { return jsonText(key) + ":" + jsonText(value) }
	fields := []string{field("toolCallId", callID), field("sessionUpdate", frame["sessionUpdate"])}
	for _, key := range []string{"title", "kind", "status"} {
		if value, present := frame[key]; present {
			fields = append(fields, field(key, value))
		}
	}
	if keys, ok := frame["rawInputKeys"].([]any); ok {
		var entries []string
		for _, key := range keys {
			if name, ok := key.(string); ok {
				entries = append(entries, field(name, "<"+name+">"))
			}
		}
		fields = append(fields, `"rawInput":{`+strings.Join(entries, ",")+`}`)
	}
	return json.RawMessage("{" + strings.Join(fields, ",") + "}")
}

// acpCallsFromSnapshot runs the snapshot's tool frames through the ACP
// projection, each opening `tool_call` starting the next call, and folds the
// records into the session view, whose tool part takes each later input.
func acpCallsFromSnapshot(t *testing.T, runtime, name string) []acpCall {
	t.Helper()
	snapshot := loadSnapshot(t, name)
	state := acp.NewProjectionState()
	started := map[string]*string{}
	opened := 0
	var records []oar.RawEvent
	for seq, raw := range jsonx.AsList(jsonx.Get(snapshot, "prompt", "tools")) {
		frame := jsonx.AsRecord(raw)
		if frame["sessionUpdate"] == "tool_call" {
			opened++
		}
		events := acp.ProjectUpdate(state, recordedUpdate(t, "recorded-"+itoa(opened), frame))
		for _, event := range events {
			if call, ok := event.(oar.ToolCallStarted); ok {
				started[call.CallID] = call.Input
			}
		}
		frameType, _ := frame["sessionUpdate"].(string)
		records = append(records, oar.RawEvent{
			Envelope: oar.Envelope{SessionID: "recorded", AgentPath: []string{}, Seq: int64(seq)},
			Kind:     oar.KindFrame,
			Frame:    oar.FrameBody{Type: frameType, Native: jsonx.Marshal(raw), Events: events},
		})
	}
	calls := []acpCall{}
	for _, message := range observe.ViewOf(records, "").Messages {
		if message.Kind != "turn" {
			continue
		}
		for _, section := range message.Sections {
			for _, part := range section.Parts {
				if part.Kind == "tool" {
					calls = append(calls, acpCall{Runtime: runtime, Tool: part.Tool, Started: started[part.CallID], Input: part.Input})
				}
			}
		}
	}
	return calls
}

// jsonText is JSON.stringify: no HTML escaping.
func jsonText(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

func itoa(n int) string {
	encoded, _ := json.Marshal(n)
	return string(encoded)
}

func utf16Head(text string, n int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= n {
		return text
	}
	return string(utf16.Decode(units[:n]))
}

func padEnd(text string, n int) string {
	if length := len(utf16.Encode([]rune(text))); length < n {
		return text + strings.Repeat(" ", n-length)
	}
	return text
}

func renderCalls(calls []acpCall) string {
	var rows []string
	for _, call := range calls {
		action := observe.ClassifyTool(call.Runtime, call.Tool, call.Input)
		row := padEnd(call.Tool, 20) + " │ " + observe.ToolActionLabel(action.Kind, "running")
		if action.Detail != "" {
			row += ": " + utf16Head(action.Detail, 40)
		}
		rows = append(rows, row)
	}
	return strings.Join(rows, "\n") + "\n"
}

func TestACPToolCallsRenderAsFriendlyActivity(t *testing.T) {
	for _, c := range []struct{ runtime, name string }{
		{"grok", "grok-acp-v1"}, {"kimi", "kimi-acp-v1"}, {"opencode", "opencode-acp-v1"}, {"opencode", "opencode-acp-v1-files"},
	} {
		t.Run(c.name, func(t *testing.T) {
			want, err := os.ReadFile(filepath.Join(replayFixtures, c.name+".activity.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if got := renderCalls(acpCallsFromSnapshot(t, c.runtime, c.name)); got != string(want) {
				t.Fatalf("got:\n%s\nwant:\n%s", got, want)
			}
		})
	}
}

func TestAnOpencodeBashCallOpensWithOnlyItsCwdAndItsCommandArrivesAsTheCallsInput(t *testing.T) {
	call := acpCallsFromSnapshot(t, "opencode", "opencode-acp-v1")[0]
	jsonEqual(t, call, map[string]any{"runtime": "opencode", "tool": "bash", "started": `{"cwd":"<cwd>"}`, "input": `{"command":"<command>","cwd":"<cwd>"}`})
	jsonEqual(t, observe.ClassifyTool(call.Runtime, call.Tool, call.Started), map[string]any{"kind": "run_command"})
	jsonEqual(t, observe.ClassifyTool(call.Runtime, call.Tool, call.Input), map[string]any{"kind": "run_command", "detail": "<command>", "command": "<command>"})
}

func TestACPShellCallsGroksOpeningInputCarriesItsCommandKimisArrivesLater(t *testing.T) {
	type classified struct {
		Action observe.ToolAction `json:"action"`
		Call   acpCall            `json:"call"`
	}
	classify := func(runtime string) []classified {
		var out []classified
		for _, call := range acpCallsFromSnapshot(t, runtime, runtime+"-acp-v1") {
			out = append(out, classified{observe.ClassifyTool(call.Runtime, call.Tool, call.Input), call})
		}
		return out
	}
	jsonEqual(t, map[string]any{"grok": classify("grok"), "kimi": classify("kimi")}, `{
		"grok": [{
			"action": {"command": "<command>", "description": "<description>", "detail": "<command>", "kind": "run_command"},
			"call": {"input": "{\"command\":\"<command>\",\"description\":\"<description>\",\"is_background\":\"<is_background>\",\"variant\":\"<variant>\"}",
				"runtime": "grok", "started": "{\"command\":\"<command>\",\"description\":\"<description>\"}", "tool": "run_terminal_command"}}],
		"kimi": [{
			"action": {"command": "<command>", "detail": "<command>", "kind": "run_command"},
			"call": {"input": "{\"command\":\"<command>\"}", "runtime": "kimi", "tool": "Bash"}}]}`)
}

func TestOpencodeFileToolsEachOpenWithAnEmptyInputAndTheLatestNamesTheFileOrTheSearch(t *testing.T) {
	var lines []string
	for _, call := range acpCallsFromSnapshot(t, "opencode", "opencode-acp-v1-files") {
		started, input := "-", "-"
		if call.Started != nil {
			started = *call.Started
		}
		if call.Input != nil {
			input = *call.Input
		}
		action := jsonText(observe.ClassifyTool(call.Runtime, call.Tool, call.Input))
		lines = append(lines, call.Tool+" "+started+" → "+input+" ⇒ "+action)
	}
	equalStrings(t, lines, []string{
		`write {} → {"content":"<content>","filePath":"<filePath>"} ⇒ {"kind":"edit_file","detail":"<filePath>","paths":["<filePath>"]}`,
		`read {} → {"filePath":"<filePath>"} ⇒ {"kind":"read_file","detail":"<filePath>","paths":["<filePath>"]}`,
		`edit {} → {"filePath":"<filePath>","newString":"<newString>","oldString":"<oldString>"} ⇒ {"kind":"edit_file","detail":"<filePath>","paths":["<filePath>"]}`,
		`grep {} → {"path":"<path>","pattern":"<pattern>"} ⇒ {"kind":"search","detail":"<path>"}`,
		`glob {} → {"path":"<path>","pattern":"<pattern>"} ⇒ {"kind":"search","detail":"<path>"}`,
		`bash {"cwd":"<cwd>"} → {"command":"<command>","workdir":"<workdir>"} ⇒ {"kind":"run_command","detail":"<command>","command":"<command>"}`,
	})
}
