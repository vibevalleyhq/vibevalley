package observe

import "testing"

// VibeValley's own agent names its tools after what they do; each lands on its kind, with the file or the command.
func TestVibeValleyToolsAreClassified(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, c := range []struct {
		tool, input string
		kind        ToolActionKind
		detail      string
	}{
		{"bash", `{"command":"git status"}`, ToolRunCommand, "git status"},
		{"read_file", `{"path":"src/a.ts"}`, ToolReadFile, "src/a.ts"},
		{"edit_file", `{"path":"README.md","old":"a","new":"b"}`, ToolEditFile, "README.md"},
		{"write_file", `{"path":"b.txt","content":"x"}`, ToolEditFile, "b.txt"},
		{"grep", `{"pattern":"TODO"}`, ToolSearch, ""},
	} {
		got := ClassifyTool("vibevalley", c.tool, str(c.input))
		if got.Kind != c.kind || (c.detail != "" && got.Detail != c.detail) {
			t.Errorf("%s: %+v, want %s %q", c.tool, got, c.kind, c.detail)
		}
	}
}
