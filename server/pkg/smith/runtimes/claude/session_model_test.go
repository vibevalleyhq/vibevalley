//go:build wip_b

package claude

import (
	"slices"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-session-model.test.ts. claude says nothing about
// the model until a turn starts; the read-back is the model of the
// system/init frame (claude 2.1.261), so a requested model the CLI silently
// replaced shows up as the replacement, not the request.

var modelInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.261"}

func b_modelIs(session oar.Session, want string) func() bool {
	return func() bool { value := session.Model().Value; return value != nil && *value == want }
}

func TestSessionModelIsNullUntilSystemInitThenReportsItsModel(t *testing.T) {
	fake := newFakeProcess(nil)
	spawner := useFakeSpawner(t, fake)
	session, err := Session(testContext(t), modelInstallation, oar.SessionOptions{Cwd: "/work", Model: "requested-y"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(spawner.call(0).args, "requested-y") {
		t.Fatalf("args = %v", spawner.call(0).args)
	}
	if session.Model().Value != nil {
		t.Fatal("model before init")
	}
	fake.emitJSON(map[string]any{"type": "system", "subtype": "init", "session_id": session.ID(), "model": "claude-x-real", "tools": []any{}})
	eventually(t, "the init model", b_modelIs(session, "claude-x-real"))
	_ = session.Dispose(testContext(t))
}

func TestSessionModelFollowsALaterSystemInitFrame(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	session, err := Session(testContext(t), modelInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	fake.emitJSON(map[string]any{"type": "system", "subtype": "init", "session_id": session.ID(), "model": "claude-x-real", "tools": []any{}})
	fake.emitJSON(map[string]any{"type": "system", "subtype": "init", "session_id": session.ID(), "model": "claude-z-later", "tools": []any{}})
	eventually(t, "both frames", func() bool { return len(session.Records()) == 2 })
	if value := session.Model().Value; value == nil || *value != "claude-z-later" {
		t.Fatalf("model = %v", value)
	}
	_ = session.Dispose(testContext(t))
}
