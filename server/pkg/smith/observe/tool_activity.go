package observe

import (
	"encoding/json"
	"math"
	"strings"
)

// Cross-runtime tool classification (observe/tool-activity.ts): the
// friendly-Activity utility. Each runtime names the same action differently
// (claude "Bash", codex "commandExecution", pi "bash"); only OAR knows the
// mapping, so it lives here. Pure: raw tool_call events stay the source of
// truth. The tool set is OPEN, so unknown tools fall back to "other" rather
// than being force-fit.

// ToolActionKind is "run_command", "read_file", "edit_file", "search",
// "web", "fetch", "subagent", "mcp", "wait" or "other".
type ToolActionKind string

const (
	ToolRunCommand ToolActionKind = "run_command"
	ToolReadFile   ToolActionKind = "read_file"
	ToolEditFile   ToolActionKind = "edit_file"
	ToolSearch     ToolActionKind = "search"
	ToolWeb        ToolActionKind = "web"
	ToolFetch      ToolActionKind = "fetch"
	ToolSubagent   ToolActionKind = "subagent"
	ToolMCP        ToolActionKind = "mcp"
	ToolWait       ToolActionKind = "wait"
	ToolOther      ToolActionKind = "other"
)

// ToolAction is one tool call as a cross-runtime action. Empty strings and a
// nil slice or pointer are absent fields.
type ToolAction struct {
	Kind ToolActionKind `json:"kind"`
	// A short target from the input: the command, a file path, a query. On
	// read_file / edit_file it is the first of Paths when there are any.
	Detail string `json:"detail,omitempty"`
	// read_file / edit_file: every file path the call involves, in the
	// runtime's order, each once; nil when the input names none.
	Paths []string `json:"paths,omitempty"`
	// run_command: the command line as the runtime reported it, for runtimes
	// whose shell input shape is recorded.
	Command string `json:"command,omitempty"`
	// The agent's own one-line account of the call, where the runtime sends
	// one; on a subagent call it is the subagent's task, also its Detail.
	Description string `json:"description,omitempty"`
	// wait: how long the agent asked to wait, in ms, as the runtime reported it.
	DurationMs *float64 `json:"durationMs,omitempty"`
}

// byRuntime maps per-runtime tool names to kinds. Names are what the
// tool_call_started event carries (codex its item type; claude/pi the tool
// name; the ACP runtimes the opening tool_call's title).
var byRuntime = map[string]map[string]ToolActionKind{
	"claude": {
		"Bash": ToolRunCommand, "Read": ToolReadFile, "Edit": ToolEditFile, "Write": ToolEditFile, "NotebookEdit": ToolEditFile,
		"Grep": ToolSearch, "Glob": ToolSearch, "WebFetch": ToolFetch, "WebSearch": ToolWeb, "Agent": ToolSubagent,
		// Agent's alias in 2.1.292: a call the model makes as `Task` is recorded as `Task`.
		"Task": ToolSubagent,
	},
	"codex": {"commandExecution": ToolRunCommand, "fileChange": ToolEditFile, "webSearch": ToolWeb, "mcpToolCall": ToolMCP, "sleep": ToolWait},
	// VibeValley's own agent (vibevalley/agent coding tools), run as the oar runtime "vibevalley" (vibevalley/agent/oarruntime).
	"vibevalley": {
		"bash": ToolRunCommand, "read_file": ToolReadFile, "list_dir": ToolReadFile, "write_file": ToolEditFile, "edit_file": ToolEditFile,
		"grep": ToolSearch, "web_fetch": ToolWeb,
	},
	"pi": {
		"bash": ToolRunCommand, "read": ToolReadFile, "ls": ToolReadFile, "edit": ToolEditFile, "write": ToolEditFile,
		"grep": ToolSearch, "find": ToolSearch,
	},
	"grok": {"run_terminal_command": ToolRunCommand},
	"kimi": {"Bash": ToolRunCommand},
	"opencode": {
		"bash": ToolRunCommand, "shell": ToolRunCommand, "subagent": ToolSubagent,
		// Native Code Mode can run MCP tools or plain JavaScript/fetch; its name alone proves neither.
		"execute": ToolOther,
		"read":    ToolReadFile, "write": ToolEditFile, "edit": ToolEditFile, "grep": ToolSearch, "glob": ToolSearch,
	},
	// The toolCall.type of @cursor/sdk 1.0.35's tool updates.
	"cursor": {
		"shell": ToolRunCommand, "read": ToolReadFile, "ls": ToolReadFile, "edit": ToolEditFile, "write": ToolEditFile,
		"delete": ToolEditFile, "grep": ToolSearch, "glob": ToolSearch, "semSearch": ToolSearch, "webSearch": ToolWeb,
		"webFetch": ToolFetch, "mcp": ToolMCP,
	},
}

func runtimeBase(runtimeID string) string { return strings.TrimSuffix(runtimeID, "-aimock") }

func toolKindOf(runtimeID, tool string) ToolActionKind {
	if kind, ok := byRuntime[runtimeBase(runtimeID)][tool]; ok {
		return kind
	}
	// MCP tools are conventionally prefixed on claude (mcp__server__tool).
	if strings.HasPrefix(tool, "mcp__") {
		return ToolMCP
	}
	return ToolOther
}

// ─── JSON helpers (shared/json.ts) ─────────────────────────────────────────

// parseJSON is JSON.parse, or nil (undefined) on a parse error.
func parseJSON(text string) any {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil
	}
	return value
}

// asRecord is a JSON object, or nil.
func asRecord(value any) map[string]any {
	record, _ := value.(map[string]any)
	return record
}

// asNumber is a finite number, or false.
func asNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) {
		return 0, false
	}
	return number, true
}

func nonEmptyString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok && text != ""
}

// inputFields are the recorded keys a host shows: command, description, durationMs.
type inputFields struct {
	command     string
	description string
	durationMs  *float64
}

// stringFields reads the recorded keys' string values: command and, where the shape has one, description.
func stringFields(inputJSON string, withDescription bool) inputFields {
	input := asRecord(parseJSON(inputJSON))
	var fields inputFields
	fields.command, _ = nonEmptyString(input["command"])
	if withDescription {
		fields.description, _ = nonEmptyString(input["description"])
	}
	return fields
}

// taskFields is a subagent call's task: the input's description only, never a command it does not run.
func taskFields(inputJSON string) inputFields {
	return inputFields{description: stringFields(inputJSON, true).description}
}

// waitFields is a wait's asked duration: the input's durationMs, when a finite positive number.
func waitFields(inputJSON string) inputFields {
	if duration, ok := asNumber(asRecord(parseJSON(inputJSON))["durationMs"]); ok && duration > 0 {
		return inputFields{durationMs: &duration}
	}
	return inputFields{}
}

func shellFields(withDescription bool) func(string) inputFields {
	return func(input string) inputFields { return stringFields(input, withDescription) }
}

// fieldsByRuntime says where each runtime's tools keep the fields a host
// shows, from recorded inputs. codex's commandExecution input is the bare
// command line, not JSON (codex/item-detail.ts).
var fieldsByRuntime = map[string]map[string]func(string) inputFields{
	"claude": {"Bash": shellFields(true), "Agent": taskFields, "Task": taskFields},
	"codex": {
		"commandExecution": func(input string) inputFields {
			if input == "" || asRecord(parseJSON(input)) != nil {
				return inputFields{}
			}
			return inputFields{command: input}
		},
		"sleep": waitFields,
	},
	"vibevalley": {"bash": shellFields(false)},
	"pi":         {"bash": shellFields(false)},
	"cursor":     {"shell": shellFields(false)},
	"grok":       {"run_terminal_command": shellFields(true)},
	"kimi":       {"Bash": shellFields(false)},
	"opencode":   {"bash": shellFields(false), "shell": shellFields(false), "subagent": taskFields},
}

var firstStringKeys = []string{"command", "cmd", "path", "file_path", "filePath", "file", "pattern", "query", "url"}

func detailOf(inputJSON string) string {
	input := asRecord(parseJSON(inputJSON))
	if input == nil {
		return ""
	}
	for _, key := range firstStringKeys {
		value := input[key]
		if text, ok := nonEmptyString(value); ok {
			return text
		}
		// codex nests the shell command as ["bash","-lc", "<cmd>"] sometimes.
		if list, ok := value.([]any); ok && len(list) > 0 {
			if last, ok := nonEmptyString(list[len(list)-1]); ok {
				return last
			}
		}
	}
	return ""
}

// ClassifyTool classifies one tool call into a cross-runtime action plus an
// extracted detail (and, for a file tool, its paths). Pass only complete
// input; inputJSON nil means none (omit it while a view part has InputPartial).
func ClassifyTool(runtimeID, tool string, inputJSON *string) ToolAction {
	kind := toolKindOf(runtimeID, tool)
	runtime := runtimeBase(runtimeID)
	var fields inputFields
	var paths []string
	if inputJSON != nil {
		if read, ok := fieldsByRuntime[runtime][tool]; ok {
			fields = read(*inputJSON)
		}
		if kind == ToolReadFile || kind == ToolEditFile {
			paths = filePathsOf(runtime, tool, *inputJSON)
		}
	}
	detail := ""
	switch {
	case len(paths) > 0:
		detail = paths[0]
	case inputJSON != nil && detailOf(*inputJSON) != "":
		detail = detailOf(*inputJSON)
	case fields.command != "":
		detail = fields.command
	case kind == ToolSubagent && fields.description != "":
		detail = fields.description
	case kind == ToolOther:
		detail = tool
	}
	action := ToolAction{Kind: kind, Detail: detail, Command: fields.command, Description: fields.description, DurationMs: fields.durationMs}
	if len(paths) > 0 {
		action.Paths = paths
	}
	return action
}

// ToolState is a call's lifecycle state for a label: "writing" (its
// arguments are still streaming), "running", "done" or "failed".
type ToolState string

var toolLabels = map[ToolActionKind]map[ToolState]string{
	ToolRunCommand: {"writing": "Preparing command", "running": "Running command", "done": "Ran command", "failed": "Command failed"},
	ToolReadFile:   {"writing": "Preparing file read", "running": "Reading file", "done": "Read file", "failed": "Read failed"},
	ToolEditFile:   {"writing": "Preparing file edit", "running": "Editing file", "done": "Edited file", "failed": "Edit failed"},
	ToolSearch:     {"writing": "Preparing search", "running": "Searching", "done": "Searched", "failed": "Search failed"},
	ToolWeb:        {"writing": "Preparing web search", "running": "Searching the web", "done": "Searched the web", "failed": "Web search failed"},
	ToolFetch:      {"writing": "Preparing page fetch", "running": "Fetching page", "done": "Fetched page", "failed": "Fetch failed"},
	ToolSubagent:   {"writing": "Preparing subagent", "running": "Running subagent", "done": "Ran subagent", "failed": "Subagent failed"},
	ToolMCP:        {"writing": "Preparing a tool call", "running": "Using a tool", "done": "Used a tool", "failed": "Tool failed"},
	ToolWait:       {"writing": "Preparing to wait", "running": "Waiting", "done": "Waited", "failed": "Wait failed"},
	ToolOther:      {"writing": "Preparing", "running": "Working", "done": "Done", "failed": "Failed"},
}

// ToolActionLabel is the human label for an action in a lifecycle state;
// tense centralized here so events stay consistent.
func ToolActionLabel(kind ToolActionKind, state ToolState) string {
	return toolLabels[kind][state]
}
