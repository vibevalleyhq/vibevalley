package base

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Worker became Session on 2026-10-17 (.agents/notes/proposed/architecture/2026-10-17-worker-is-a-session.md). A home
// written before keeps the old file and keys; MoveSessionFiles brings it to today's once, before anything reads it, and
// writes it back.

// The keys that changed in state.json and sessions.json.
var sessionKeys = map[string]string{"workers": "sessions", "worker": "session", "workerId": "sessionId", "sessionId": "oarSessionId"}

// MoveSessionFiles renames workers.json to sessions.json and the old keys in both it and state.json. sessionId means
// oar's session only in sessions.json's hands; in state.json it is not a key.
func MoveSessionFiles(home string) error {
	old, now := filepath.Join(home, "workers.json"), filepath.Join(home, "sessions.json")
	if _, err := os.Stat(now); os.IsNotExist(err) {
		if body, err := os.ReadFile(old); err == nil {
			if err := os.WriteFile(now, renameKeys(body, sessionKeys), 0o644); err != nil {
				return err
			}
			if err := os.Remove(old); err != nil {
				return err
			}
		}
	}
	state := filepath.Join(home, "state.json")
	body, err := os.ReadFile(state)
	if err != nil {
		return nil
	}
	keys := map[string]string{"workers": "sessions", "worker": "session", "workerId": "sessionId"}
	if moved := renameKeys(body, keys); string(moved) != string(body) {
		return os.WriteFile(state, moved, 0o644)
	}
	return nil
}

// renameKeys renames object keys anywhere in a JSON document; a body that is not JSON comes back as it was.
func renameKeys(body []byte, keys map[string]string) []byte {
	var v any
	if json.Unmarshal(body, &v) != nil {
		return body
	}
	changed := false
	var walk func(any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			out := make(map[string]any, len(x))
			for k, e := range x {
				if n, ok := keys[k]; ok {
					k, changed = n, true
				}
				out[k] = walk(e)
			}
			return out
		case []any:
			for i, e := range x {
				x[i] = walk(e)
			}
		}
		return v
	}
	v = walk(v)
	if !changed {
		return body
	}
	out, err := json.Marshal(v)
	if err != nil {
		return body
	}
	return out
}
