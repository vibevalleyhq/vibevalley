package observe

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Ported from tests/tool-activity.test.ts.

func taJSON(t *testing.T, value any) *string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	return &text
}

func taStr(text string) *string { return &text }

func taFloat(value float64) *float64 { return &value }

func taAssert(t *testing.T, got, want ToolAction) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	// The JSON shape omits absent fields exactly like the TS object.
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("json %s, want %s", gotJSON, wantJSON)
	}
}

func TestClassifyToolUnifiesShellTools(t *testing.T) {
	for _, c := range []struct{ runtime, tool, command string }{{"claude", "Bash", "echo hi"}, {"codex-aimock", "commandExecution", "ls"}, {"pi", "bash", "pwd"}} {
		if kind := ClassifyTool(c.runtime, c.tool, taJSON(t, map[string]any{"command": c.command})).Kind; kind != ToolRunCommand {
			t.Fatalf("%s %s: %s", c.runtime, c.tool, kind)
		}
	}
}

func TestClassifyToolMapsKindsAcrossRuntimes(t *testing.T) {
	for _, c := range []struct {
		runtime, tool string
		kind          ToolActionKind
	}{
		{"claude", "Read", ToolReadFile}, {"claude", "Write", ToolEditFile}, {"codex", "fileChange", ToolEditFile},
		{"pi", "grep", ToolSearch}, {"claude", "WebSearch", ToolWeb}, {"codex", "mcpToolCall", ToolMCP},
		{"claude", "mcp__github__create_issue", ToolMCP},
	} {
		if kind := ClassifyTool(c.runtime, c.tool, nil).Kind; kind != c.kind {
			t.Fatalf("%s %s: %s, want %s", c.runtime, c.tool, kind, c.kind)
		}
	}
}

func TestClassifyToolFallsBackToOther(t *testing.T) {
	taAssert(t, ClassifyTool("pi", "some_custom_tool", nil), ToolAction{Kind: ToolOther, Detail: "some_custom_tool"})
}

func TestClassifyToolDetailAcrossSpellings(t *testing.T) {
	for _, c := range []struct {
		runtime, tool string
		input         any
		detail        string
	}{
		{"claude", "Bash", map[string]any{"command": "echo hi"}, "echo hi"},
		{"codex", "commandExecution", map[string]any{"cmd": "ls -la"}, "ls -la"},
		{"claude", "Read", map[string]any{"file_path": "/a/b.ts"}, "/a/b.ts"},
		// codex nests the command in an argv array
		{"codex", "commandExecution", map[string]any{"command": []string{"bash", "-lc", "echo deep"}}, "echo deep"},
	} {
		if detail := ClassifyTool(c.runtime, c.tool, taJSON(t, c.input)).Detail; detail != c.detail {
			t.Fatalf("%s %s: %q, want %q", c.runtime, c.tool, detail, c.detail)
		}
	}
}

func TestClassifyToolCursor(t *testing.T) {
	taAssert(t, ClassifyTool("cursor", "shell", taJSON(t, map[string]any{"command": "echo TOOL-MARK-4412", "timeout": 30000})),
		ToolAction{Kind: ToolRunCommand, Detail: "echo TOOL-MARK-4412", Command: "echo TOOL-MARK-4412"})
	taAssert(t, ClassifyTool("cursor", "read", taJSON(t, map[string]any{"path": "/tmp/note.txt"})),
		ToolAction{Kind: ToolReadFile, Detail: "/tmp/note.txt", Paths: []string{"/tmp/note.txt"}})
	for tool, kind := range map[string]ToolActionKind{"edit": ToolEditFile, "glob": ToolSearch, "webFetch": ToolFetch, "task": ToolOther} {
		if got := ClassifyTool("cursor", tool, nil).Kind; got != kind {
			t.Fatalf("cursor %s: %s", tool, got)
		}
	}
}

func TestClassifyToolGrokShell(t *testing.T) {
	taAssert(t, ClassifyTool("grok", "run_terminal_command", taJSON(t, map[string]any{"description": "List the files"})),
		ToolAction{Kind: ToolRunCommand, Description: "List the files"})
	taAssert(t, ClassifyTool("grok", "run_terminal_command", nil), ToolAction{Kind: ToolRunCommand})
}

// #321: fetching one page is not a web search, and a subagent call is a subagent.
func TestClassifyToolFetchAndSubagent(t *testing.T) {
	taAssert(t, ClassifyTool("claude", "WebFetch", taJSON(t, map[string]any{"url": "https://example.com/a", "prompt": "Summarize"})),
		ToolAction{Kind: ToolFetch, Detail: "https://example.com/a"})
	claude := map[string]any{"description": "Run echo command", "subagent_type": "general-purpose", "prompt": "Run the shell command `echo SUB_OK` and report the exact output.", "run_in_background": false}
	taAssert(t, ClassifyTool("claude", "Agent", taJSON(t, claude)), ToolAction{Kind: ToolSubagent, Detail: "Run echo command", Description: "Run echo command"})
	opencode := map[string]any{"agent": "general", "description": "Echo child check", "prompt": "Run `echo CHILD-OK-7731` in its shell and report the output."}
	taAssert(t, ClassifyTool("opencode", "subagent", taJSON(t, opencode)), ToolAction{Kind: ToolSubagent, Detail: "Echo child check", Description: "Echo child check"})
	taAssert(t, ClassifyTool("claude", "Agent", nil), ToolAction{Kind: ToolSubagent})
	taAssert(t, ClassifyTool("claude", "Task", taJSON(t, claude)), ToolAction{Kind: ToolSubagent, Detail: "Run echo command", Description: "Run echo command"})
	for _, c := range []struct {
		kind  ToolActionKind
		state ToolState
		label string
	}{{ToolFetch, "running", "Fetching page"}, {ToolSubagent, "running", "Running subagent"}, {ToolWeb, "writing", "Preparing web search"}} {
		if got := ToolActionLabel(c.kind, c.state); got != c.label {
			t.Fatalf("%s %s: %q", c.kind, c.state, got)
		}
	}
}

func TestToolActionLabelTenses(t *testing.T) {
	for _, c := range []struct {
		kind  ToolActionKind
		state ToolState
		label string
	}{{ToolRunCommand, "running", "Running command"}, {ToolRunCommand, "done", "Ran command"}, {ToolReadFile, "failed", "Read failed"}} {
		if got := ToolActionLabel(c.kind, c.state); got != c.label {
			t.Fatalf("%s %s: %q", c.kind, c.state, got)
		}
	}
}

// codex reports the model waiting as a sleep item (#84).
func TestClassifyToolCodexSleep(t *testing.T) {
	taAssert(t, ClassifyTool("codex", "sleep", taJSON(t, map[string]any{"durationMs": 50000})), ToolAction{Kind: ToolWait, DurationMs: taFloat(50000)})
	taAssert(t, ClassifyTool("codex", "sleep", nil), ToolAction{Kind: ToolWait})
	for _, input := range []string{`{"durationMs":-1}`, `{"durationMs":0}`, `{"durationMs":"50000"}`, "{not json"} {
		taAssert(t, ClassifyTool("codex", "sleep", taStr(input)), ToolAction{Kind: ToolWait})
	}
	if ToolActionLabel(ToolWait, "running") != "Waiting" || ToolActionLabel(ToolWait, "done") != "Waited" {
		t.Fatal("wait labels")
	}
}

// #166: paths on read_file / edit_file.
func TestClassifyToolFileToolsPaths(t *testing.T) {
	calls := []struct {
		runtime, tool string
		input         map[string]any
		file          string
	}{
		{"claude", "Read", map[string]any{"file_path": "/w/a.ts", "offset": 1, "limit": 20}, "/w/a.ts"},
		{"claude", "Edit", map[string]any{"file_path": "/w/a.ts", "old_string": "x", "new_string": "y"}, "/w/a.ts"},
		{"claude", "Write", map[string]any{"file_path": "/w/a.ts", "content": "x"}, "/w/a.ts"},
		{"pi", "read", map[string]any{"path": "src/a.ts", "offset": 1}, "src/a.ts"},
		{"pi", "ls", map[string]any{"path": "src"}, "src"},
		{"pi", "edit", map[string]any{"path": "src/a.ts", "edits": []any{map[string]any{"oldText": "x", "newText": "y"}}}, "src/a.ts"},
		{"pi", "write", map[string]any{"path": "src/a.ts", "content": "x"}, "src/a.ts"},
		{"cursor", "read", map[string]any{"path": "/w/a.ts"}, "/w/a.ts"},
		{"cursor", "ls", map[string]any{"path": "/w"}, "/w"},
		{"cursor", "edit", map[string]any{"path": "/w/a.ts"}, "/w/a.ts"},
		{"cursor", "write", map[string]any{"path": "/w/a.ts", "fileText": "x"}, "/w/a.ts"},
		{"cursor", "delete", map[string]any{"path": "/w/a.ts"}, "/w/a.ts"},
		{"opencode", "read", map[string]any{"filePath": "/w/a.ts"}, "/w/a.ts"},
	}
	for _, c := range calls {
		action := ClassifyTool(c.runtime, c.tool, taJSON(t, c.input))
		if action.Detail != c.file || !reflect.DeepEqual(action.Paths, []string{c.file}) {
			t.Fatalf("%s %s: %+v", c.runtime, c.tool, action)
		}
	}
}

func TestClassifyToolNotebookEdit(t *testing.T) {
	taAssert(t, ClassifyTool("claude", "NotebookEdit", taJSON(t, map[string]any{"notebook_path": "/w/n.ipynb", "cell_id": "c1", "new_source": "x"})),
		ToolAction{Kind: ToolEditFile, Detail: "/w/n.ipynb", Paths: []string{"/w/n.ipynb"}})
}

func TestClassifyToolPathsAbsent(t *testing.T) {
	taAssert(t, ClassifyTool("claude", "Read", nil), ToolAction{Kind: ToolReadFile})
	taAssert(t, ClassifyTool("opencode", "write", taStr("{}")), ToolAction{Kind: ToolEditFile})
	taAssert(t, ClassifyTool("codex", "fileChange", nil), ToolAction{Kind: ToolEditFile})
	taAssert(t, ClassifyTool("codex", "fileChange", taStr("[]")), ToolAction{Kind: ToolEditFile})
	taAssert(t, ClassifyTool("claude", "NotebookEdit", taJSON(t, map[string]any{"cell_id": "c1", "new_source": "x"})), ToolAction{Kind: ToolEditFile})
	taAssert(t, ClassifyTool("pi", "grep", taJSON(t, map[string]any{"pattern": "x", "path": "src"})), ToolAction{Kind: ToolSearch, Detail: "src"})
	taAssert(t, ClassifyTool("claude", "Bash", taJSON(t, map[string]any{"command": "cat a.ts"})), ToolAction{Kind: ToolRunCommand, Detail: "cat a.ts", Command: "cat a.ts"})
}

func TestClassifyToolCodexFileChangePaths(t *testing.T) {
	changes := []any{
		map[string]any{"path": "/w/a.txt", "kind": map[string]any{"type": "update", "move_path": "/w/b.txt"}, "diff": ""},
		map[string]any{"path": "/w/b.txt", "kind": map[string]any{"type": "delete"}, "diff": ""},
		map[string]any{"path": "/w/c.txt", "kind": map[string]any{"type": "update", "move_path": nil}, "diff": ""},
	}
	taAssert(t, ClassifyTool("codex-aimock", "fileChange", taJSON(t, changes)),
		ToolAction{Kind: ToolEditFile, Detail: "/w/a.txt", Paths: []string{"/w/a.txt", "/w/b.txt", "/w/c.txt"}})
}
