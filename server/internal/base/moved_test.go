package base

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A home from before Session: workers.json becomes sessions.json, and both files take today's keys.
func TestMoveSessionFiles(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "workers.json"), []byte(`{"hired":3,"hands":[{"id":"w3","sessionId":"oar-1"}]}`), 0o644)
	os.WriteFile(filepath.Join(home, "state.json"), []byte(`{"workers":[{"id":"w3","issue":"t1"}],"inbox":[]}`), 0o644)
	if err := MoveSessionFiles(home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "workers.json")); !os.IsNotExist(err) {
		t.Fatal("workers.json is still there")
	}
	sessions, _ := os.ReadFile(filepath.Join(home, "sessions.json"))
	state, _ := os.ReadFile(filepath.Join(home, "state.json"))
	if !strings.Contains(string(sessions), `"oarSessionId":"oar-1"`) || !strings.Contains(string(state), `"sessions":[`) || strings.Contains(string(state), "worker") {
		t.Fatalf("sessions.json %s\nstate.json %s", sessions, state)
	}
	again, _ := os.ReadFile(filepath.Join(home, "state.json"))
	if err := MoveSessionFiles(home); err != nil {
		t.Fatal(err)
	}
	if now, _ := os.ReadFile(filepath.Join(home, "state.json")); string(now) != string(again) {
		t.Fatal("moved twice")
	}
}
