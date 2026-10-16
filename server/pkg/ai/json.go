package ai

// Tool arguments as they stream in: half a JSON object, read as much as it says. And the whole of it at the end.
// Arguments stay JSON text (json.RawMessage), so their keys keep the model's order as JSON.stringify keeps them.
// Also the JSON writing this port shares: JSON.stringify's way (no HTML escaping, keys in the order given).

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// marshal is JSON.stringify: no HTML escaping, no trailing newline. Values that cannot be written are null.
func marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// Stringify is JSON.stringify of v, for whatever is written to disk or the wire.
func Stringify(v any) string { return string(marshal(v)) }

// object writes a JSON object with its keys in the order they are set.
type object struct{ buf bytes.Buffer }

func newObject() *object {
	o := &object{}
	o.buf.WriteByte('{')
	return o
}

func (o *object) setRaw(key string, raw []byte) {
	if o.buf.Len() > 1 {
		o.buf.WriteByte(',')
	}
	o.buf.Write(marshal(key))
	o.buf.WriteByte(':')
	o.buf.Write(raw)
}

func (o *object) set(key string, v any) { o.setRaw(key, marshal(v)) }

func (o *object) bytes() []byte {
	out := append([]byte(nil), o.buf.Bytes()...)
	return append(out, '}')
}

// isObject reports JSON text that is one whole object.
func isObject(text []byte) bool {
	t := bytes.TrimSpace(text)
	return len(t) > 0 && t[0] == '{' && json.Valid(t)
}

// compactObject is a JSON object without its whitespace; nil when text is not one.
func compactObject(text []byte) json.RawMessage {
	if !isObject(text) {
		return nil
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, bytes.TrimSpace(text)); err != nil {
		return nil
	}
	return json.RawMessage(buf.Bytes())
}

// Entry is one key of a JSON object and its value as JSON.
type Entry struct {
	Key   string
	Value json.RawMessage
}

// ObjectEntries is a JSON object's keys and values in its order; nil when it is not an object.
func ObjectEntries(raw []byte) []Entry {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil
	}
	entries := []Entry{}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil
		}
		k, _ := key.(string)
		entries = append(entries, Entry{Key: k, Value: value})
	}
	return entries
}

// ObjectOf writes entries as a JSON object, in their order.
func ObjectOf(entries []Entry) json.RawMessage {
	o := newObject()
	for _, e := range entries {
		o.setRaw(e.Key, compactValue(e.Value))
	}
	return o.bytes()
}

func compactValue(raw json.RawMessage) []byte {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return raw
	}
	return buf.Bytes()
}

var (
	danglingKeyAfterComma = regexp.MustCompile(`,\s*"(?:[^"\\]|\\.)*"\s*:?\s*$`)
	danglingFirstKey      = regexp.MustCompile(`\{\s*"(?:[^"\\]|\\.)*"\s*:?\s*$`)
	danglingPunctuation   = regexp.MustCompile(`[,:]\s*$`)
)

// RepairJSON closes what a cut-off JSON text left open (strings, objects, arrays), dropping a dangling key or comma.
func RepairJSON(text string) string {
	var closers []byte
	inString := false
	escaped := false
	for _, ch := range text {
		if inString {
			switch {
			case escaped:
				escaped = false
			case ch == '\\':
				escaped = true
			case ch == '"':
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{':
			closers = append(closers, '}')
		case '[':
			closers = append(closers, ']')
		case '}', ']':
			if len(closers) > 0 {
				closers = closers[:len(closers)-1]
			}
		}
	}
	out := text
	if inString {
		if escaped {
			out += `\"`
		} else {
			out += `"`
		}
	}
	// A key with no value yet, or a trailing comma or colon, cannot be closed: cut it.
	out = danglingKeyAfterComma.ReplaceAllString(out, "")
	out = danglingFirstKey.ReplaceAllString(out, "{")
	out = danglingPunctuation.ReplaceAllString(out, "")
	var b strings.Builder
	b.WriteString(out)
	for i := len(closers) - 1; i >= 0; i-- {
		b.WriteByte(closers[i])
	}
	return b.String()
}

// ParseStreamingJSON is as much of a JSON object as has come; {} when nothing can be read yet.
func ParseStreamingJSON(text string) json.RawMessage {
	if strings.TrimSpace(text) == "" {
		return json.RawMessage("{}")
	}
	for _, candidate := range []string{text, RepairJSON(text)} {
		if parsed := compactObject([]byte(candidate)); parsed != nil {
			return parsed
		}
	}
	return json.RawMessage("{}")
}

// WithoutNulls is arguments without their top-level nulls: models send null for an optional parameter they leave out.
func WithoutNulls(params json.RawMessage) json.RawMessage {
	entries := ObjectEntries(params)
	if entries == nil {
		return params
	}
	kept := entries[:0]
	for _, e := range entries {
		if string(bytes.TrimSpace(e.Value)) != "null" {
			kept = append(kept, e)
		}
	}
	return ObjectOf(kept)
}

// ParseToolArguments is a tool call's arguments once they are all there. Arguments that cannot be read reach the
// tool as `_unparsed`, fail its schema, and the model sees why.
func ParseToolArguments(text string) json.RawMessage {
	if strings.TrimSpace(text) == "" {
		return json.RawMessage("{}")
	}
	if whole := compactObject([]byte(text)); whole != nil {
		return whole
	}
	// Cut off: read what there is.
	read := ParseStreamingJSON(text)
	if len(ObjectEntries(read)) > 0 {
		return read
	}
	o := newObject()
	o.set("_unparsed", text)
	return o.bytes()
}
