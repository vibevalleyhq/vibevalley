package handler_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"slices"
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

// An issue's lifecycle acts on its newest session: before it was started there is none.
func TestIssueLifecycleNeedsASession(t *testing.T) {
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
	issue, err := c.IssueCreate(ctx, protocol.IssueRequest{Title: "写打卡"})
	if err != nil {
		t.Fatal(err)
	}
	var refused protocol.Refused
	for name, err := range map[string]error{
		"comment": c.IssueComment(ctx, issue.ID, protocol.CommentRequest{Text: "快点"}),
		"done":    status(c, issue.ID, protocol.IssueStatusDone),
		"working": status(c, issue.ID, protocol.IssueStatusInProgress),
		"resolve": c.IssueResolve(ctx, issue.ID),
	} {
		if !errors.As(err, &refused) {
			t.Errorf("%s before a start: %v", name, err)
		}
	}
	if _, err := c.IssueChanges(ctx, issue.ID); !errors.As(err, &refused) {
		t.Errorf("changes before a start: %v", err)
	}
	var missing protocol.Missing
	if err := status(c, "nope", protocol.IssueStatusDone); !errors.As(err, &missing) {
		t.Errorf("an issue that is not there: %v", err)
	}
}

func status(c *protocol.Client, id string, to protocol.IssueStatus) error {
	_, err := c.IssueStatus(context.Background(), id, protocol.IssueStatusRequest{Status: to})
	return err
}

func TestFreshAgentListHasValidRequiredEnums(t *testing.T) {
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
	agents, err := c.AgentList(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	manager := false
	for _, a := range agents {
		manager = manager || a.ID == protocol.ManagerAgent
		if !slices.Contains(protocol.BuildValues, a.Look.Build) || !slices.Contains(protocol.HeadValues, a.Look.Head) || !slices.Contains(protocol.PersonaModeValues, a.PersonaMode) {
			t.Fatalf("agent list has invalid required enum: %+v", a)
		}
	}
	if !manager {
		t.Fatal("manager missing from list")
	}
}

func TestChannelCreationReturnsItsIdentity(t *testing.T) {
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
	id, err := c.ChannelCreate(context.Background(), protocol.ChannelRequest{Name: " #hello "})
	if err != nil || id == "" {
		t.Fatalf("create: id=%q err=%v", id, err)
	}
	found := false
	for _, channel := range f.Channel.Channels() {
		if channel.ID == id && channel.Name == "hello" {
			found = true
		}
	}
	if !found {
		t.Fatalf("returned identity is not the created channel: %q", id)
	}
	if _, err := c.ChannelHistory(context.Background(), id, nil, nil); err != nil {
		t.Fatal(err)
	}
}
