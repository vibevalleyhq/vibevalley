package handler_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"vibevalley/internal/handler"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/internal/workspace"
)

// A save under one id with a body for another is refused, not written under the body's.
func TestSaveTakesThePathsID(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Voice.Line.Port, cfg.Lan.Port = 0, 0
	f, err := workspace.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	srv := httptest.NewServer(handler.New(f))
	defer srv.Close()
	c := &protocol.Client{Base: srv.URL}
	ctx := context.Background()
	var refused protocol.Refused
	lab := fixture.Lab(t)
	if _, err := c.AgentSave(ctx, "other", lab); !errors.As(err, &refused) {
		t.Fatalf("agent under another id: %v", err)
	}
	if _, err := c.AgentSave(ctx, lab.ID, lab); err != nil {
		t.Fatalf("agent: %v", err)
	}
	if _, err := c.SkillSave(ctx, "other", protocol.Skill{ID: "go", Name: "Go"}); !errors.As(err, &refused) {
		t.Fatalf("skill under another id: %v", err)
	}
}
