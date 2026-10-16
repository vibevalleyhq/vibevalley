package codex

import (
	"bytes"
	"encoding/json"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Tool item detail (item-detail.ts). Each reader takes the item's raw JSON:
// where TS JSON.stringify's a native sub-value, the raw bytes keep its key order.

// codexItem is a tool item, decoded and as raw fields.
type codexItem struct {
	record jsonx.Record
	fields map[string]json.RawMessage
}

func readItem(raw json.RawMessage) codexItem {
	return codexItem{record: jsonx.ParseRecord(raw), fields: jsonx.RawFields(raw)}
}

// codexItemInput is a tool item's `tool_call_started.input`; nil when it has none.
func codexItemInput(raw json.RawMessage) *string {
	item := readItem(raw)
	switch item.record["type"] {
	case "commandExecution":
		if command, ok := item.record["command"].(string); ok {
			return &command
		}
	case "fileChange":
		if _, ok := item.record["changes"].([]any); ok {
			text := jsonx.Stringify(item.fields["changes"])
			return &text
		}
	case "mcpToolCall":
		// The app-server schema defines arguments as a JSON value. Preserve that
		// value exactly instead of guessing a human-readable representation.
		if arguments, ok := item.fields["arguments"]; ok {
			text := jsonx.Stringify(arguments)
			return &text
		}
	case "webSearch":
		if query, ok := item.record["query"].(string); ok {
			return &query
		}
	case "sleep":
		if _, ok := item.record["durationMs"].(float64); ok {
			text := `{"durationMs":` + jsNumber(item.fields["durationMs"]) + `}`
			return &text
		}
	}
	return nil
}

// jsNumber is a JSON number token as JSON.stringify writes the number.
func jsNumber(raw json.RawMessage) string {
	var number float64
	if json.Unmarshal(raw, &number) != nil {
		return string(raw)
	}
	encoded, _ := json.Marshal(number)
	return string(encoded)
}

// codexItemExitCode is the exit status of a `commandExecution` item: null is
// codex's own "no code" (a signal), nil means the item carries none (still
// running, declined).
func codexItemExitCode(raw json.RawMessage) *oar.NullInt {
	item := readItem(raw)
	value, present := item.record["exitCode"]
	if item.record["type"] != "commandExecution" || !present {
		return nil
	}
	if code, ok := value.(float64); ok {
		return oar.IntOf(int(code))
	}
	return oar.NullOf()
}

// statusOf is a status word (`declined`, `completed`) when a command or file change reported nothing else.
func statusOf(item codexItem) any {
	if status, ok := item.record["status"].(string); ok {
		return status
	}
	return nil
}

// mcpContent is an `mcpToolCall` result (`{content, structuredContent?,
// _meta?}`, the content being MCP blocks [src] app-server v2
// `McpToolCallResult`): its blocks, or the whole result when it has none; an
// error is its message.
func mcpContent(item codexItem) []oar.ToolOutputPart {
	if message, ok := jsonx.AsRecord(item.record["error"])["message"].(string); ok {
		return []oar.ToolOutputPart{{Type: "text", Text: "error: " + message}}
	}
	result := jsonx.AsRecord(item.record["result"])
	if result == nil {
		return nil
	}
	if content, ok := result["content"].([]any); ok {
		if parts := oar.ToolContent(content); parts != nil {
			return parts
		}
	}
	return []oar.ToolOutputPart{{Type: "other", Value: compactRaw(item.fields["result"])}}
}

func compactRaw(raw json.RawMessage) json.RawMessage {
	return json.RawMessage(jsonx.Stringify(raw))
}

// codexToolContent is a finished tool item's `tool_call_ended.content`.
func codexToolContent(raw json.RawMessage) []oar.ToolOutputPart {
	item := readItem(raw)
	switch item.record["type"] {
	case "commandExecution":
		// The exit status travels as `tool_call_ended.exitCode`; the content is the command's own output.
		if output, ok := item.record["aggregatedOutput"].(string); ok && output != "" {
			return oar.ToolContent(output)
		}
		return oar.ToolContent(statusOf(item))
	case "fileChange":
		return oar.ToolContent(statusOf(item))
	case "mcpToolCall":
		return mcpContent(item)
	case "webSearch":
		if _, ok := item.record["results"].([]any); ok {
			return []oar.ToolOutputPart{{Type: "other", Value: compactRaw(item.fields["results"])}}
		}
	}
	return nil
}

// objectKeys is a JSON object's keys in their wire order (JS Object.keys);
// nil when raw is not an object.
func objectKeys(raw json.RawMessage) []string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	keys := []string{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return keys
		}
		key, _ := token.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if decoder.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}
