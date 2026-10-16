package grok

// tests/fixtures/acp-session-support.ts profile() and start(): grok's
// profile with the fake agent's launch line, auth and mode.

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// overFixture is `{...base, ...profile({args})}`: base with the fake agent's
// launch line (session mode unless args say otherwise), cached auth, nested
// attribution and the yolo mode.
func overFixture(base acp.Profile, args ...string) acp.Profile {
	profile := base
	if len(args) == 0 {
		args = []string{fixture, "session"}
	}
	profile.Args = acp.StaticArgs(args...)
	profile.Capabilities = acp.Capabilities{Attribution: "nested"}
	profile.SelectAuthMethod = func(jsonx.Record) string { return "cached" }
	profile.AbortTimeout = 500 * time.Millisecond
	profile.ConfigureSession = func(configure acp.ConfigureContext) error {
		_, err := configure.Request("session/set_mode", map[string]any{"sessionId": configure.SessionID, "modeId": "yolo"})
		return err
	}
	return profile
}

func startOn(t *testing.T, profile acp.Profile, resume string) oar.Session {
	t.Helper()
	cwd, _ := os.Getwd()
	session, err := acp.Session(profile)(testContext(t), nodeInstallation(t), oar.SessionOptions{Cwd: cwd, Resume: resume})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = session.Dispose(context.Background()) })
	return session
}

// persisted is the records after a JSON round trip: the host's replay boundary.
func persisted(t *testing.T, records []oar.RawEvent) []oar.RawEvent {
	t.Helper()
	encoded, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	var restored []oar.RawEvent
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	return restored
}
