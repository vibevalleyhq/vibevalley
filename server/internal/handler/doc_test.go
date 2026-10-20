package handler_test

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"vibevalley/internal/handler"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/internal/workspace"
)

// The document routes, over HTTP: create, submit ops as the owner, read back, export and import Markdown.
func TestDocRoutes(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Voice.Line.Port, cfg.Lan.Port = 0, 0
	f, err := workspace.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.Project.GitHubProbe = fixture.NoGitHub
	t.Cleanup(f.Close)
	srv := httptest.NewServer(handler.New(f))
	defer srv.Close()
	c := &protocol.Client{Base: srv.URL}
	ctx := context.Background()

	created, err := c.DocCreate(ctx, protocol.DocRequest{Title: "计划书"})
	if err != nil || created.Doc.Title != "计划书" || len(created.Blocks) != 0 {
		t.Fatalf("%+v %v", created, err)
	}
	id := created.Doc.ID
	level := int64(1)
	ack, err := c.DocSubmit(ctx, id, protocol.DocSubmit{BatchID: "b1", Ops: []protocol.DocOp{
		{Value: protocol.DocOpInsertBlock{Block: protocol.Block{ID: "h", OrderKey: "V", Type: protocol.BlockHeading, Attrs: protocol.BlockAttrs{Level: &level}, Text: []protocol.DocSpan{{T: "目标"}}}}},
		{Value: protocol.DocOpInsertBlock{Block: protocol.Block{ID: "p", OrderKey: "W", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{{T: "先做第一步😀"}}}}},
		{Value: protocol.DocOpSplitBlock{BlockID: "p", BaseRev: 1, Offset: 2, NewBlock: protocol.Block{ID: "q", OrderKey: "X", Type: protocol.BlockParagraph}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	// The split's base was rev 1 of p, which the insert in the same batch made.
	if ack.Seq != 1 || len(ack.Results) != 3 || ack.Results[2].Status != protocol.DocOpStatusApplied || len(ack.Blocks) != 3 {
		t.Fatalf("%+v", ack)
	}
	for _, b := range ack.Blocks {
		if b.UpdatedBy != protocol.DocOwner {
			t.Fatalf("written by %s", b.UpdatedBy)
		}
	}
	got, err := c.DocGet(ctx, id)
	if err != nil || len(got.Blocks) != 3 || got.Blocks[2].Text[0].T != "第一步😀" {
		t.Fatalf("%+v %v", got, err)
	}
	md, err := c.DocMarkdown(ctx, id)
	if err != nil || md.Markdown != "# 目标\n\n先做\n\n第一步😀\n" {
		t.Fatalf("%q %v", md.Markdown, err)
	}
	imported, err := c.DocImport(ctx, protocol.DocImport{Title: "导入的", Markdown: md.Markdown})
	if err != nil || len(imported.Blocks) != 3 || imported.Blocks[0].Type != protocol.BlockHeading {
		t.Fatalf("%+v %v", imported, err)
	}
	list, err := c.DocList(ctx)
	if err != nil || len(list) != 2 {
		t.Fatalf("%+v %v", list, err)
	}
	var missing protocol.Missing
	if _, err := c.DocGet(ctx, "nope"); !errors.As(err, &missing) {
		t.Fatalf("missing doc: %v", err)
	}
	var refused protocol.Refused
	if _, err := c.DocSubmit(ctx, id, protocol.DocSubmit{}); !errors.As(err, &refused) || !strings.Contains(refused.Reason, "batchId") {
		t.Fatalf("no batch id: %v", err)
	}
}
