package observe

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// A turn's work between its words (observe/tool-groups.ts), for hosts that
// show it as one line ("Ran 3 commands, read a file") opening to the calls.
// Pure, over a section's parts: tool calls and the reasoning between them,
// back to back, make one group; text, notices and app requests stay where
// they are and end a group. The counts are data, so a host can word or
// translate them; ToolGroupSummary is the English line.

// ToolCount is how many calls of one kind a group holds.
type ToolCount struct {
	Kind  ToolActionKind `json:"kind"`
	Count int            `json:"count"`
}

// ToolGroupSegment is a part as it is (Kind "part": Index, Part) or a group
// of tool calls and reasoning (Kind "tools": Index, Parts, Counts, Failed, Running).
type ToolGroupSegment struct {
	Kind string `json:"kind"`
	// Where the segment starts in the section's parts.
	Index int `json:"index"`
	// Kind "part": the part.
	Part *ViewPart `json:"part,omitempty"`
	// Kind "tools": its tool calls and reasoning, in order.
	Parts []ViewPart `json:"parts,omitempty"`
	// Tool calls by ClassifyTool kind, each kind once, in the order it first came.
	Counts []ToolCount `json:"counts,omitempty"`
	// Calls whose result is "failed".
	Failed int `json:"failed"`
	// The call still running, if one is: what a live line names.
	Running *ViewPart `json:"running,omitempty"`
}

func (s ToolGroupSegment) MarshalJSON() ([]byte, error) {
	if s.Kind == "part" {
		return marshalNoEscape(map[string]any{"kind": "part", "index": s.Index, "part": s.Part})
	}
	out := map[string]any{"kind": "tools", "index": s.Index, "parts": nonNilSlice(s.Parts), "counts": nonNilSlice(s.Counts), "failed": s.Failed}
	if s.Running != nil {
		out["running"] = s.Running
	}
	return marshalNoEscape(out)
}

// classifyForGroup is ClassifyTool; a test replaces it to see what grouping passes.
var classifyForGroup = ClassifyTool

func toolGroup(runtimeID string, index int, parts []ViewPart) ToolGroupSegment {
	var counts []ToolCount
	failed := 0
	var running *ViewPart
	for i, part := range parts {
		if part.Kind != "tool" {
			continue
		}
		// A call's kind depends on its runtime and tool name only, never its
		// input: parsing every call's input again on each grouping made a live
		// host pay tools x input per record (#318).
		kind := classifyForGroup(runtimeID, part.Tool, nil).Kind
		found := false
		for c := range counts {
			if counts[c].Kind == kind {
				counts[c].Count++
				found = true
			}
		}
		if !found {
			counts = append(counts, ToolCount{Kind: kind, Count: 1})
		}
		if part.Result == "failed" {
			failed++
		}
		if part.Result == "running" {
			running = &parts[i]
		}
	}
	if counts == nil {
		counts = []ToolCount{}
	}
	return ToolGroupSegment{Kind: "tools", Index: index, Parts: parts, Counts: counts, Failed: failed, Running: running}
}

// GroupToolActivity reads a section's parts as they read: words and requests
// as they are, the work between them grouped.
func GroupToolActivity(runtimeID string, parts []ViewPart) []ToolGroupSegment {
	segments := []ToolGroupSegment{}
	pendingIndex := -1
	var pending []ViewPart
	flush := func() {
		if pendingIndex != -1 {
			segments = append(segments, toolGroup(runtimeID, pendingIndex, pending))
			pendingIndex, pending = -1, nil
		}
	}
	for index, part := range parts {
		if part.Kind == "tool" || part.Kind == "reasoning" {
			if pendingIndex == -1 {
				pendingIndex = index
			}
			pending = append(pending, part)
			continue
		}
		flush()
		segments = append(segments, ToolGroupSegment{Kind: "part", Index: index, Part: &parts[index]})
	}
	flush()
	return segments
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return fmt.Sprintf(many, n)
}

var doneWords = map[ToolActionKind]func(int) string{
	ToolRunCommand: func(n int) string { return plural(n, "ran a command", "ran %d commands") },
	ToolReadFile:   func(n int) string { return plural(n, "read a file", "read %d files") },
	ToolEditFile:   func(n int) string { return plural(n, "edited a file", "edited %d files") },
	ToolSearch:     func(n int) string { return plural(n, "searched", "searched %d times") },
	ToolWeb:        func(n int) string { return plural(n, "searched the web", "searched the web %d times") },
	ToolFetch:      func(n int) string { return plural(n, "fetched a page", "fetched %d pages") },
	ToolSubagent:   func(n int) string { return plural(n, "ran a subagent", "ran %d subagents") },
	ToolMCP:        func(n int) string { return plural(n, "used a tool", "used %d tools") },
	ToolWait:       func(n int) string { return plural(n, "waited", "waited %d times") },
	ToolOther:      func(n int) string { return plural(n, "used a tool", "used %d tools") },
}

// ToolGroupSummary is the English line for a group's counts: "Ran 3
// commands, read a file". MCP and unclassified tools read alike ("used 2
// tools"). A group with no calls (only reasoning) reads "Thought", or
// "Thinking…" while running (state "running"; "" or "done" otherwise).
// Display wording may change in a minor release.
func ToolGroupSummary(counts []ToolCount, state string) string {
	if len(counts) == 0 {
		switch state {
		case "running":
			return "Thinking…"
		case "", "done":
			return "Thought"
		default:
			panic(fmt.Sprintf("Unknown group state: %s", state))
		}
	}
	tools := 0
	for _, count := range counts {
		if count.Kind == ToolMCP || count.Kind == ToolOther {
			tools += count.Count
		}
	}
	var phrases []string
	toolsSaid := false
	for _, count := range counts {
		if count.Kind == ToolMCP || count.Kind == ToolOther {
			if !toolsSaid {
				phrases = append(phrases, doneWords[ToolOther](tools))
				toolsSaid = true
			}
		} else {
			phrases = append(phrases, doneWords[count.Kind](count.Count))
		}
	}
	text := strings.Join(phrases, ", ")
	first, size := utf8.DecodeRuneInString(text)
	return string(unicode.ToUpper(first)) + text[size:]
}
