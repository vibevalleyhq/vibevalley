package ai

// Arguments stay JSON text (json.RawMessage), so their keys keep the model's order as JSON.stringify keeps them.

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// JSON.stringify: no HTML escaping, no trailing newline. Values that cannot be written are null.
func marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func Stringify(v any) string { return string(marshal(v)) }

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

func isObject(text []byte) bool {
	t := bytes.TrimSpace(text)
	return len(t) > 0 && t[0] == '{' && json.Valid(t)
}

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

type Entry struct {
	Key   string
	Value json.RawMessage
}

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

// Models send null for an optional parameter they leave out.
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

// Arguments that cannot be read reach the tool as `_unparsed`, fail its schema, and the model sees why.
func ParseToolArguments(text string) json.RawMessage {
	if strings.TrimSpace(text) == "" {
		return json.RawMessage("{}")
	}
	if whole := compactObject([]byte(text)); whole != nil {
		return whole
	}
	read := ParseStreamingJSON(text)
	if len(ObjectEntries(read)) > 0 {
		return read
	}
	o := newObject()
	o.set("_unparsed", text)
	return o.bytes()
}
