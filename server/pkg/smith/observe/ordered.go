package observe

import (
	"bytes"
	"encoding/json"
	"slices"
)

// OrderedMap is an immutable string-keyed map that iterates in insertion
// order, the way a JS Map does: deleting a key and setting it again moves it
// to the end. The folds treat a published *OrderedMap as frozen; writes go
// through a copy-on-write (cow) taken per record, so a record that changes
// nothing keeps the previous map, pointer and all (conversation.ts #300).
//
// JSON: an array of [key, value] pairs in iteration order, the shape the
// parity generator writes for a TS Map.
type OrderedMap[V any] struct {
	keys   []string
	values map[string]V
}

// NewOrderedMap is an empty map.
func NewOrderedMap[V any]() *OrderedMap[V] {
	return &OrderedMap[V]{values: map[string]V{}}
}

// Len is the number of entries.
func (m *OrderedMap[V]) Len() int {
	if m == nil {
		return 0
	}
	return len(m.keys)
}

// Get reads one entry.
func (m *OrderedMap[V]) Get(key string) (V, bool) {
	if m == nil {
		var zero V
		return zero, false
	}
	value, ok := m.values[key]
	return value, ok
}

// Has reports whether key is present.
func (m *OrderedMap[V]) Has(key string) bool {
	_, ok := m.Get(key)
	return ok
}

// Keys is the keys in iteration order (a copy).
func (m *OrderedMap[V]) Keys() []string {
	if m == nil {
		return nil
	}
	return slices.Clone(m.keys)
}

// Values is the values in iteration order.
func (m *OrderedMap[V]) Values() []V {
	if m == nil {
		return nil
	}
	out := make([]V, 0, len(m.keys))
	for _, key := range m.keys {
		out = append(out, m.values[key])
	}
	return out
}

// All iterates in insertion order.
func (m *OrderedMap[V]) All(yield func(string, V) bool) {
	if m == nil {
		return
	}
	for _, key := range m.keys {
		if !yield(key, m.values[key]) {
			return
		}
	}
}

func (m *OrderedMap[V]) clone() *OrderedMap[V] {
	out := &OrderedMap[V]{keys: slices.Clone(m.keys), values: make(map[string]V, len(m.values))}
	if m != nil {
		for key, value := range m.values {
			out.values[key] = value
		}
	}
	return out
}

// With is a copy with key set (appended when new, in place otherwise).
func (m *OrderedMap[V]) With(key string, value V) *OrderedMap[V] {
	next := m.clone()
	next.set(key, value)
	return next
}

// Without is a copy without key; the same map when key is absent.
func (m *OrderedMap[V]) Without(key string) *OrderedMap[V] {
	if !m.Has(key) {
		return m
	}
	next := m.clone()
	next.delete(key)
	return next
}

func (m *OrderedMap[V]) set(key string, value V) {
	if _, ok := m.values[key]; !ok {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

func (m *OrderedMap[V]) delete(key string) {
	if _, ok := m.values[key]; !ok {
		return
	}
	delete(m.values, key)
	m.keys = slices.DeleteFunc(m.keys, func(k string) bool { return k == key })
}

func (m *OrderedMap[V]) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('[')
	for i, key := range m.keys {
		if i > 0 {
			out.WriteByte(',')
		}
		pair, err := json.Marshal([]any{key, m.values[key]})
		if err != nil {
			return nil, err
		}
		out.Write(pair)
	}
	out.WriteByte(']')
	return out.Bytes(), nil
}

// cow is a map copied on its first write: a record that changes nothing
// keeps the previous map, and its identity (conversation.ts copyOnWrite).
type cow[V any] struct {
	previous *OrderedMap[V]
	own      *OrderedMap[V]
}

func cowOf[V any](previous *OrderedMap[V]) *cow[V] {
	if previous == nil {
		previous = NewOrderedMap[V]()
	}
	return &cow[V]{previous: previous}
}

func (c *cow[V]) written() *OrderedMap[V] {
	if c.own == nil {
		c.own = c.previous.clone()
	}
	return c.own
}

func (c *cow[V]) get(key string) (V, bool) { return c.current().Get(key) }
func (c *cow[V]) set(key string, value V)  { c.written().set(key, value) }
func (c *cow[V]) delete(key string) {
	if c.current().Has(key) {
		c.written().delete(key)
	}
}

func (c *cow[V]) current() *OrderedMap[V] {
	if c.own != nil {
		return c.own
	}
	return c.previous
}

// jsonKey is JSON.stringify of a string list, byte for byte: no HTML escaping.
func jsonKey(values ...any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(values); err != nil {
		panic(err)
	}
	return string(bytes.TrimSuffix(out.Bytes(), []byte("\n")))
}

// pathOrEmpty normalizes a nil agent path to [], as every record carries one.
func pathOrEmpty(path []string) []string {
	if path == nil {
		return []string{}
	}
	return path
}

// marshalNoEscape marshals without HTML escaping, as JSON.stringify does.
func marshalNoEscape(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
}
