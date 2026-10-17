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

// A log from before results were their own events has a tool/call carrying its output and ok. splitResults gives each
// such call a tool/result right after it and numbers the log again, carrying under, on and call to the new numbers. A log
// with none is left as it is.
func splitResults(body []byte) ([]byte, bool) {
	var records []map[string]any
	if json.Unmarshal(body, &records) != nil {
		return body, false
	}
	split := false
	for _, r := range records {
		if r["type"] == "tool/call" && (r["output"] != nil || r["ok"] != nil) {
			split = true
			break
		}
	}
	if !split {
		return body, false
	}
	renumbered := map[float64]float64{}
	var out []map[string]any
	for _, r := range records {
		seq, _ := r["seq"].(float64)
		renumbered[seq] = float64(len(out))
		r["seq"] = float64(len(out))
		out = append(out, r)
		if r["type"] != "tool/call" || (r["output"] == nil && r["ok"] == nil) {
			continue
		}
		result := map[string]any{"seq": float64(len(out)), "time": r["time"], "type": "tool/result", "call": seq, "text": ""}
		for _, k := range []string{"output", "ok", "under", "run"} {
			if v, ok := r[k]; ok {
				result[k] = v
			}
		}
		delete(r, "output")
		delete(r, "ok")
		out = append(out, result)
	}
	for _, r := range out {
		for _, k := range []string{"under", "on", "call"} {
			if v, ok := r[k].(float64); ok {
				if n, ok := renumbered[v]; ok {
					r[k] = n
				}
			}
		}
	}
	moved, err := json.Marshal(out)
	if err != nil {
		return body, false
	}
	return moved, true
}

// splitAllResults brings every log in dir to results of their own, once: a log already so is not written.
func splitAllResults(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".head.json") {
			continue
		}
		file := filepath.Join(dir, name)
		body, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		if moved, ok := splitResults(body); ok {
			if err := os.WriteFile(file, moved, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
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
