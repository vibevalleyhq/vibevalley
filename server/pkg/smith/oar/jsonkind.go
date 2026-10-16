package oar

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// withKind marshals v (a struct whose MarshalJSON was stripped by an alias
// type) and puts `"kind":kind` first, the shape every TS union member has.
func withKind(kind string, v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return prependField("kind", kind, body), nil
}

// prependField puts `"name":"value"` before the fields of a marshalled object.
func prependField(name, value string, object []byte) []byte {
	var out bytes.Buffer
	out.WriteString(`{"`)
	out.WriteString(name)
	out.WriteString(`":`)
	out.WriteString(strconv.Quote(value))
	if len(object) > 2 {
		out.WriteByte(',')
		out.Write(object[1:])
	} else {
		out.WriteByte('}')
	}
	return out.Bytes()
}

// kindOf reads the "kind" discriminator of a JSON object.
func kindOf(raw []byte) (string, error) {
	var probe struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return "", err
	}
	return probe.Kind, nil
}

// object is an ordered builder for JSON objects whose fields depend on a
// discriminator, used where a flat Go struct stands for a TS union.
type object struct {
	buf   bytes.Buffer
	first bool
}

func newObject() *object {
	o := &object{first: true}
	o.buf.WriteByte('{')
	return o
}

func (o *object) field(name string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	o.raw(name, encoded)
	return nil
}

func (o *object) raw(name string, encoded []byte) {
	if !o.first {
		o.buf.WriteByte(',')
	}
	o.first = false
	o.buf.WriteString(strconv.Quote(name))
	o.buf.WriteByte(':')
	o.buf.Write(encoded)
}

func (o *object) bytes() []byte {
	o.buf.WriteByte('}')
	return o.buf.Bytes()
}
