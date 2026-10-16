package claude

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Helpers for the ports of tests/*.test.ts that drive claude.

// cAssertMatches is vitest toMatchObject: every key of want is in got with a
// matching value (objects recursively, arrays element by element, same length).
func cAssertMatches(t *testing.T, got any, want string) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var left, right any
	if err := json.Unmarshal(encoded, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &right); err != nil {
		t.Fatalf("bad expectation %s: %v", want, err)
	}
	if !cMatches(left, right) {
		t.Fatalf("got  %s\ndoes not match %s", encoded, want)
	}
}

func cMatches(got, want any) bool {
	switch typed := want.(type) {
	case map[string]any:
		object, ok := got.(map[string]any)
		if !ok {
			return false
		}
		for key, value := range typed {
			present, ok := object[key]
			if !ok || !cMatches(present, value) {
				return false
			}
		}
		return true
	case []any:
		list, ok := got.([]any)
		if !ok || len(list) != len(typed) {
			return false
		}
		for index := range typed {
			if !cMatches(list[index], typed[index]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(got, want)
}
