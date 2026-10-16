package grok

// Ported from tests/grok/grok-mcp-redaction.test.ts: the session stream
// case. The redaction rule itself is tested where it lives
// (internal/shared credential_redaction_test.go).

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"vibevalley/pkg/smith/oar"
)

type collected struct {
	mu      sync.Mutex
	records []oar.RawEvent
}

func (c *collected) add(record oar.RawEvent) {
	c.mu.Lock()
	c.records = append(c.records, record)
	c.mu.Unlock()
}

func (c *collected) all() []oar.RawEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]oar.RawEvent{}, c.records...)
}

func observeAll(session oar.Session) *collected {
	out := &collected{}
	session.RawEvents(out.add, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	return out
}

func TestCredentialsNeverEnterQueuedStartupRecordsLiveObservationsOrReplay(t *testing.T) {
	profile := Profile
	profile.Args = func(oar.SessionOptions) []string { return []string{fixture, "grok-credentials"} }
	session := startOn(t, profile, "")
	observed := observeAll(session)
	promptAndWait(t, session, "hello")
	if err := session.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	var native []json.RawMessage
	for _, record := range session.Records() {
		if record.Kind == oar.KindFrame && record.Frame.Type == "_x.ai/mcp/servers_updated" {
			native = append(native, record.Frame.Native)
		}
	}
	servers := []any{
		map[string]any{"name": "local", "source": "local", "type": "stdio", "command": "echo", "args": []any{}, "env": []any{map[string]any{"name": "API_KEY", "value": "[redacted]"}}},
		map[string]any{"name": "remote", "type": "http", "url": "https://example.test/mcp", "headers": []any{map[string]any{"name": "Authorization", "value": "[redacted]"}}, "bearer_token": "[redacted]"},
	}
	jsonEqual(t, native, []any{map[string]any{"phase": "opening", "mcpServers": servers}, map[string]any{"phase": "live", "mcpServers": servers}})

	replayed := observeAll(session)
	records := session.Records()
	if !eventually(func() bool { return len(observed.all()) == len(records) && len(replayed.all()) == len(records) }, 5e9) {
		t.Fatalf("observed %d, replayed %d, records %d", len(observed.all()), len(replayed.all()), len(records))
	}
	jsonEqual(t, observed.all(), records)
	jsonEqual(t, replayed.all(), records)
	for _, stream := range [][]oar.RawEvent{records, observed.all(), replayed.all()} {
		encoded, _ := json.Marshal(stream)
		for _, secret := range []string{"fixture-env-secret", "fixture-header-secret", "fixture-bearer-secret"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatalf("%s leaked", secret)
			}
		}
	}
}
