package claude

import (
	"bytes"
	"encoding/json"
	"strconv"

	"vibevalley/pkg/smith/internal/jsonx"
)

// Go-only helpers: reading claude's stream-json frames while keeping the
// native bytes TS would re-serialize with JSON.stringify (key order kept,
// no HTML escaping).

// nativeMessage is one parsed stdout frame: the decoded record and the line
// it came from, which is the frame's Native.
type nativeMessage struct {
	jsonx.Record
	raw json.RawMessage
}

// parseNative reads one stdout line; false when it is not a JSON object.
func parseNative(line []byte) (nativeMessage, bool) {
	record := jsonx.ParseRecord(line)
	if record == nil {
		return nativeMessage{}, false
	}
	return nativeMessage{Record: record, raw: json.RawMessage(bytes.Clone(line))}, true
}

// nativeOf builds a message from a record (tests, synthesized frames).
func nativeOf(record jsonx.Record) nativeMessage {
	return nativeMessage{Record: record, raw: json.RawMessage(jsonText(record))}
}

// rawField is the verbatim JSON of an object's field (compacted), nil when absent.
func rawField(raw json.RawMessage, key string) json.RawMessage {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	value, ok := fields[key]
	if !ok {
		return nil
	}
	return compact(value)
}

func compact(raw json.RawMessage) json.RawMessage {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return raw
	}
	return buffer.Bytes()
}

// jsonText is JSON.stringify of a value: no HTML escaping, no trailing newline.
func jsonText(value any) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "null"
	}
	return string(bytes.TrimSuffix(buffer.Bytes(), []byte("\n")))
}

// firstFieldRaw is the first field's value of a JSON object in document
// order (TS Object.values(record)[0]), nil when none.
func firstFieldRaw(raw json.RawMessage) json.RawMessage {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil
	}
	if !decoder.More() {
		return nil
	}
	if _, err := decoder.Token(); err != nil {
		return nil
	}
	var value json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return value
}

// contentBlock is one object of message.content, decoded and raw by field.
type contentBlock struct {
	jsonx.Record
	fields map[string]json.RawMessage
}

// contentBlocks is message.message.content's object entries (TS contentBlocks).
func contentBlocks(message nativeMessage) []contentBlock {
	content, ok := jsonx.AsRecord(message.Record["message"])["content"].([]any)
	if !ok {
		return nil
	}
	var rawContent []json.RawMessage
	if inner := rawField(message.raw, "message"); inner != nil {
		_ = json.Unmarshal(rawField(inner, "content"), &rawContent)
	}
	blocks := make([]contentBlock, 0, len(content))
	for index, entry := range content {
		record := jsonx.AsRecord(entry)
		if record == nil {
			continue
		}
		block := contentBlock{Record: record}
		if index < len(rawContent) {
			_ = json.Unmarshal(rawContent[index], &block.fields)
		}
		blocks = append(blocks, block)
	}
	return blocks
}

// rawOf is a block field's verbatim JSON (compacted), re-marshalled when the raw form is missing.
func (b contentBlock) rawOf(key string) json.RawMessage {
	if raw, ok := b.fields[key]; ok {
		return compact(raw)
	}
	return json.RawMessage(jsonText(b.Record[key]))
}

func str(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

func itoa(value int64) string { return strconv.FormatInt(value, 10) }
