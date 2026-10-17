package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// A session's log was activities/<id>.json of {n, at, kind}; it is events/<id>.json of {seq, time, type}, named as DeepSeek
// Harness names its session events (2026-10-17). moveActivities brings an old home to it once: each log rewritten, each head
// copied as it is, the old folder removed.

var activityTypes = map[string]string{
	"prompt": "user/message", "recalled": "memory/recalled", "thought": "assistant/thinking", "response": "assistant/message",
	"action": "tool/call", "retry": "llm/retry", "error": "run/error",
}

func moveActivities(old, now string) error {
	entries, err := os.ReadDir(old)
	if err != nil {
		return nil
	}
	if _, err := os.Stat(now); err == nil {
		return nil
	}
	if err := os.MkdirAll(now, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		body, err := os.ReadFile(filepath.Join(old, name))
		if err != nil {
			return err
		}
		if strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".head.json") {
			body = movedEvents(body)
		}
		if err := os.WriteFile(filepath.Join(now, name), body, 0o644); err != nil {
			return err
		}
	}
	return os.RemoveAll(old)
}

// A log that does not read as a list of records is copied as it is: the journal reads it as empty, as it would have.
func movedEvents(body []byte) []byte {
	var records []map[string]any
	if json.Unmarshal(body, &records) != nil {
		return body
	}
	for _, r := range records {
		for from, to := range map[string]string{"n": "seq", "at": "time", "kind": "type"} {
			if v, ok := r[from]; ok {
				r[to] = v
				delete(r, from)
			}
		}
		if kind, ok := r["type"].(string); ok {
			if t, ok := activityTypes[kind]; ok {
				r["type"] = t
			}
		}
	}
	out, err := json.Marshal(records)
	if err != nil {
		return body
	}
	return out
}
