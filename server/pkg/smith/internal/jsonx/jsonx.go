// Package jsonx holds narrowing helpers for untyped JSON from native runtime
// surfaces (shared/json.ts) and an order-preserving string rewriter for
// redaction.
package jsonx

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"time"
)

// Record is a JSON object decoded into Go values.
type Record = map[string]any

// Parse decodes JSON text; ok is false for invalid JSON.
func Parse(text []byte) (any, bool) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(text))
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}
	if decoder.More() {
		return nil, false
	}
	return value, true
}

// ParseRecord decodes a JSON object; nil when the text is not one.
func ParseRecord(text []byte) Record {
	value, ok := Parse(text)
	if !ok {
		return nil
	}
	return AsRecord(value)
}

// AsRecord narrows to an object; nil otherwise.
func AsRecord(value any) Record {
	record, _ := value.(map[string]any)
	return record
}

// AsList narrows to an array; nil otherwise.
func AsList(value any) []any {
	list, _ := value.([]any)
	return list
}

// AsRecordList keeps the object members of an array.
func AsRecordList(value any) []Record {
	var records []Record
	for _, entry := range AsList(value) {
		if record := AsRecord(entry); record != nil {
			records = append(records, record)
		}
	}
	return records
}

// AsString narrows to a string.
func AsString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// Str is the string at key, "" when absent or not a string.
func Str(record Record, key string) string {
	text, _ := record[key].(string)
	return text
}

// StrOK is the string at key and whether it was one.
func StrOK(record Record, key string) (string, bool) {
	text, ok := record[key].(string)
	return text, ok
}

// AsNumber narrows to a finite number.
func AsNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		if math.IsInf(v, 0) || math.IsNaN(v) {
			return 0, false
		}
		return v, true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	}
	return 0, false
}

// Num is the number at key and whether it was one.
func Num(record Record, key string) (float64, bool) { return AsNumber(record[key]) }

// Int64 is the number at key as an int64 pointer, nil when absent.
func Int64(record Record, key string) *int64 {
	number, ok := Num(record, key)
	if !ok {
		return nil
	}
	value := int64(number)
	return &value
}

// Bool is the boolean at key and whether it was one.
func Bool(record Record, key string) (bool, bool) {
	value, ok := record[key].(bool)
	return value, ok
}

// Get walks object keys; nil when any step is missing.
func Get(value any, path ...string) any {
	current := value
	for _, key := range path {
		record := AsRecord(current)
		if record == nil {
			return nil
		}
		current = record[key]
	}
	return current
}

// Marshal encodes a value; it never fails for decoded JSON.
func Marshal(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

// EpochInstant reads an epoch in seconds or milliseconds as an ISO-8601 instant.
func EpochInstant(value any) (string, bool) {
	raw, ok := AsNumber(value)
	if !ok {
		return "", false
	}
	ms := raw
	if raw < 1_000_000_000_000 {
		ms = raw * 1000
	}
	t := time.UnixMilli(int64(ms))
	return t.UTC().Format("2006-01-02T15:04:05.000Z"), true
}

// MapStrings rewrites every string (object keys included) in a JSON text
// through f, keeping object key order and all other tokens. changed is false
// (and out is the input) when f changed nothing.
func MapStrings(raw []byte, f func(string) string) (out []byte, changed bool, err error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var buf bytes.Buffer
	type frame struct {
		object    bool
		expectKey bool
		count     int
	}
	var stack []frame
	separator := func() {
		if len(stack) == 0 {
			return
		}
		top := &stack[len(stack)-1]
		if !top.object {
			if top.count > 0 {
				buf.WriteByte(',')
			}
			top.count++
			return
		}
		if top.expectKey {
			if top.count > 0 {
				buf.WriteByte(',')
			}
			top.expectKey = false
			return
		}
		buf.WriteByte(':')
		top.expectKey = true
		top.count++
	}
	for {
		token, tokenErr := decoder.Token()
		if tokenErr != nil {
			if errors.Is(tokenErr, io.EOF) {
				break
			}
			return raw, false, tokenErr
		}
		switch t := token.(type) {
		case json.Delim:
			switch t {
			case '{', '[':
				separator()
				buf.WriteByte(byte(t))
				stack = append(stack, frame{object: t == '{', expectKey: t == '{'})
			case '}', ']':
				buf.WriteByte(byte(t))
				stack = stack[:len(stack)-1]
			}
		case string:
			separator()
			mapped := f(t)
			if mapped != t {
				changed = true
			}
			encoded, _ := json.Marshal(mapped)
			buf.Write(encoded)
		case json.Number:
			separator()
			buf.WriteString(t.String())
		case bool:
			separator()
			buf.WriteString(strconv.FormatBool(t))
		case nil:
			separator()
			buf.WriteString("null")
		}
	}
	if !changed {
		return raw, false, nil
	}
	return buf.Bytes(), true, nil
}

// RawFields is an object's fields as raw JSON, in their original form; nil
// when raw is not an object. Use it where TS JSON.stringify's a native
// sub-value into a string: re-marshalling a decoded map would sort its keys,
// where JS keeps their insertion order.
func RawFields(raw []byte) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	return fields
}

// Stringify is JSON.stringify of a raw JSON value: compact, key order kept.
func Stringify(raw json.RawMessage) string {
	var out bytes.Buffer
	if err := json.Compact(&out, raw); err != nil {
		return string(raw)
	}
	return out.String()
}
