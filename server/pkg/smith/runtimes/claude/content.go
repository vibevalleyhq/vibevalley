package claude

import (
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// partialBlock is a streamed content block: text or thinking (Text,
// Finalized), or a tool_use (CallID). Only a tool's identity is kept:
// argument fragments are emitted, never parsed or accumulated here.
type partialBlock struct {
	Type      string
	Text      string
	Finalized bool
	CallID    string
}

type indexedBlock struct {
	Index float64
	Block partialBlock
}

// partialMessage is one unfinished API message: its id (HasID) and its
// blocks by stream index, in the order they first appeared (a JS Map).
type partialMessage struct {
	ID     string
	HasID  bool
	Blocks []indexedBlock
}

func (m partialMessage) block(index float64) (partialBlock, bool) {
	for _, entry := range m.Blocks {
		if entry.Index == index {
			return entry.Block, true
		}
	}
	return partialBlock{}, false
}

// withBlock is m with the block at index set (in place when it exists, as Map.set keeps the position).
func (m partialMessage) withBlock(index float64, block partialBlock) partialMessage {
	blocks := make([]indexedBlock, 0, len(m.Blocks)+1)
	replaced := false
	for _, entry := range m.Blocks {
		if entry.Index == index {
			entry.Block = block
			replaced = true
		}
		blocks = append(blocks, entry)
	}
	if !replaced {
		blocks = append(blocks, indexedBlock{Index: index, Block: block})
	}
	m.Blocks = blocks
	return m
}

// claudePartials holds only unfinished API messages, per agent lane.
// Children can stream while root is idle. Never modified in place.
type claudePartials map[string]partialMessage

func textEvent(kind, text string, message partialMessage) oar.EventBody {
	id := ""
	if message.HasID {
		id = message.ID
	}
	if kind == "text" {
		return oar.TextDelta{Text: text, MessageID: id}
	}
	return oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: text}, MessageID: id}
}

// streamContent folds one stream_event's event into the lane's partial message.
func streamContent(previous *partialMessage, event jsonx.Record) (*partialMessage, []oar.EventBody) {
	if event["type"] == "message_start" {
		message := partialMessage{}
		if id, ok := jsonx.AsRecord(event["message"])["id"].(string); ok {
			message.ID, message.HasID = id, true
		}
		return &message, nil
	}
	message := partialMessage{}
	if previous != nil {
		message = *previous
	}
	var body jsonx.Record
	switch event["type"] {
	case "content_block_start":
		body = jsonx.AsRecord(event["content_block"])
	case "content_block_delta":
		body = jsonx.AsRecord(event["delta"])
	}
	index, ok := event["index"].(float64)
	if !ok {
		return previous, nil
	}
	if body["type"] == "tool_use" {
		id, idOK := body["id"].(string)
		name, nameOK := body["name"].(string)
		if idOK && nameOK {
			prior, had := message.block(index)
			next := message.withBlock(index, partialBlock{Type: "tool_use", CallID: id})
			if had && prior.Type == "tool_use" && prior.CallID == id {
				return &next, nil
			}
			return &next, []oar.EventBody{oar.ToolCallStarted{CallID: id, Tool: name}}
		}
	}
	if body["type"] == "input_json_delta" {
		if delta, ok := body["partial_json"].(string); ok {
			tool, had := message.block(index)
			if had && tool.Type == "tool_use" {
				return previous, []oar.EventBody{oar.ToolCallInputDelta{CallID: tool.CallID, Delta: delta}}
			}
			return previous, nil
		}
	}
	kind := ""
	switch body["type"] {
	case "text", "text_delta":
		kind = "text"
	case "thinking", "thinking_delta":
		kind = "thinking"
	default:
		return previous, nil
	}
	text, _ := body[kind].(string)
	prefix := ""
	if event["type"] != "content_block_start" {
		if prior, had := message.block(index); had && prior.Type == kind {
			prefix = prior.Text
		}
	}
	next := message.withBlock(index, partialBlock{Type: kind, Text: prefix + text})
	if text == "" {
		return &next, nil
	}
	return &next, []oar.EventBody{textEvent(kind, text, message)}
}

// finalContent reads a completed assistant frame. Native 2.1.293 emits one
// completed block just before its content_block_stop, with the same API id
// for every block. Consume that block's streamed prefix once, rather than
// treating an entire message id as already projected.
func finalContent(message nativeMessage, partial *partialMessage) (*partialMessage, []oar.EventBody) {
	id, hasID := jsonx.AsRecord(message.Record["message"])["id"].(string)
	messageID := ""
	if hasID {
		messageID = id
	}
	working := partialMessage{}
	if partial != nil {
		working = *partial
		working.Blocks = append([]indexedBlock(nil), partial.Blocks...)
	}
	// remainder is what of full the stream has not shown; false (TS null) when nothing.
	remainder := func(kind, full string) (string, bool) {
		if !hasID || partial == nil || !partial.HasID || partial.ID != id {
			return full, true
		}
		for position, entry := range working.Blocks {
			if entry.Block.Type != kind || entry.Block.Finalized {
				continue
			}
			working.Blocks[position].Block.Finalized = true
			if entry.Block.Text == "" || !strings.HasPrefix(full, entry.Block.Text) {
				return full, true
			}
			suffix := full[len(entry.Block.Text):]
			return suffix, suffix != ""
		}
		return full, true
	}
	var events []oar.EventBody
	for _, block := range contentBlocks(message) {
		switch block.Record["type"] {
		case "text":
			if full, ok := block.Record["text"].(string); ok {
				if text, some := remainder("text", full); some {
					events = append(events, oar.TextDelta{Text: text, MessageID: messageID})
				}
			}
		case "thinking":
			full, _ := block.Record["thinking"].(string)
			if text, some := remainder("thinking", full); some {
				content := oar.ReasoningContent{Kind: "empty"}
				if text != "" {
					content = oar.ReasoningContent{Kind: "text", Text: text}
				}
				events = append(events, oar.Reasoning{Content: content, MessageID: messageID})
			}
		case "redacted_thinking":
			events = append(events, oar.Reasoning{Content: oar.ReasoningContent{Kind: "redacted"}, MessageID: messageID})
		case "tool_use":
			// A streamed start already announced this call. The completed block
			// replaces its input, even before content_block_stop (native order).
			sameMessage := partial == nil || !partial.HasID || (hasID && partial.ID == id)
			callID, _ := block.Record["id"].(string)
			_, isString := block.Record["id"].(string)
			started := false
			if sameMessage && isString {
				for _, entry := range working.Blocks {
					if entry.Block.Type == "tool_use" && entry.Block.CallID == callID {
						started = true
						break
					}
				}
			}
			_, hasInput := block.Record["input"]
			if started {
				if hasInput {
					events = append(events, oar.ToolCallInput{CallID: callID, Input: string(block.rawOf("input"))})
				}
				break
			}
			if !isString {
				callID = "unknown"
			}
			tool, ok := block.Record["name"].(string)
			if !ok {
				tool = "unknown"
			}
			started2 := oar.ToolCallStarted{CallID: callID, Tool: tool}
			if hasInput {
				input := string(block.rawOf("input"))
				started2.Input = &input
			}
			events = append(events, started2)
		}
	}
	if partial == nil {
		return nil, events
	}
	return &working, events
}

// claudeContent is the pure content projection; the caller records the
// original frame even if events is empty. partials is never modified.
func claudeContent(partials claudePartials, message nativeMessage, agentPath []string) (claudePartials, []oar.EventBody) {
	lane := jsonText(nonNilPath(agentPath))
	event := jsonx.AsRecord(message.Record["event"])
	if message.Record["type"] == "stream_event" && event["type"] == "message_stop" {
		// Every completed assistant block precedes this native boundary. Only
		// this agent is done; other agents may still have partial output pending.
		remaining := make(claudePartials, len(partials))
		for key, value := range partials {
			if key != lane {
				remaining[key] = value
			}
		}
		return remaining, nil
	}
	var previous *partialMessage
	if known, ok := partials[lane]; ok {
		previous = &known
	}
	var next *partialMessage
	var events []oar.EventBody
	if message.Record["type"] == "stream_event" {
		if event == nil {
			event = jsonx.Record{}
		}
		next, events = streamContent(previous, event)
	} else {
		next, events = finalContent(message, previous)
	}
	if next == nil {
		return partials, events
	}
	updated := make(claudePartials, len(partials)+1)
	for key, value := range partials {
		updated[key] = value
	}
	updated[lane] = *next
	return updated, events
}

// claudeToolResults reads a user frame's tool results.
func claudeToolResults(message nativeMessage) []oar.EventBody {
	var out []oar.EventBody
	for _, block := range contentBlocks(message) {
		callID, ok := block.Record["tool_use_id"].(string)
		if block.Record["type"] != "tool_result" || !ok {
			continue
		}
		// The Messages API defines is_error as optional and false by default,
		// and claude 2.1.288 leaves it out of a successful Read, Write or Edit
		// result (Bash carries false): an absent field is the protocol's own
		// "no error", not a missing report.
		result := "ok"
		if block.Record["is_error"] == true {
			result = "failed"
		}
		out = append(out, oar.ToolCallEnded{CallID: callID, Content: oar.ToolContent(block.Record["content"]), Result: result})
	}
	return out
}

func nonNilPath(path []string) []string {
	if path == nil {
		return []string{}
	}
	return path
}
