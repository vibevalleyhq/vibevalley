package doc

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

func open(t *testing.T, path string) *Service {
	t.Helper()
	db, err := base.OpenDB(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s, err := newService(db)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func submit(t *testing.T, s *Service, doc, batch string, ops ...protocol.DocOpValue) protocol.DocAck {
	t.Helper()
	var list []protocol.DocOp
	for _, o := range ops {
		list = append(list, op(o))
	}
	ack, err := s.Submit(context.Background(), doc, protocol.DocOwner, protocol.DocSubmit{BatchID: batch, Ops: list})
	if err != nil {
		t.Fatal(err)
	}
	return ack
}

func texts(snap protocol.DocSnapshot) string {
	var out []string
	for _, b := range snap.Blocks {
		out = append(out, plain(b.Text))
	}
	return strings.Join(out, "|")
}

// What one person writes is there after the server starts again: blocks, revs, the doc's seq.
func TestEditsSurviveARestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "vibevalley.db")
	s := open(t, path)
	d, err := s.Create(ctx, "周报")
	if err != nil {
		t.Fatal(err)
	}
	id := d.Doc.ID
	submit(t, s, id, "b1", protocol.DocOpInsertBlock{Block: para("a", "V", "你好世界")})
	submit(t, s, id, "b2", protocol.DocOpSplitBlock{BlockID: "a", BaseRev: 1, Offset: 2, NewBlock: para("b", "W", "")})
	submit(t, s, id, "b3", protocol.DocOpUpdateText{BlockID: "b", BaseRev: 1, Text: []protocol.DocSpan{bold("世界🌾")}})

	again := open(t, path)
	snap, err := again.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if texts(snap) != "你好|世界🌾" || snap.Doc.Seq != 3 || snap.Doc.Title != "周报" {
		t.Fatalf("%q seq %d", texts(snap), snap.Doc.Seq)
	}
	if b := snap.Blocks[1]; b.Rev != 2 || !b.Text[0].Marks.Bold || b.UpdatedBy != protocol.DocOwner || b.DocID != id {
		t.Fatalf("%+v", b)
	}
	list, _ := again.List(ctx)
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("list %+v", list)
	}
}

// The same batch sent twice is taken once and answered the same: one seq, one change.
func TestABatchIsTakenOnce(t *testing.T) {
	ctx := context.Background()
	s := open(t, ":memory:")
	d, _ := s.Create(ctx, "")
	first := submit(t, s, d.Doc.ID, "same", protocol.DocOpInsertBlock{Block: para("a", "V", "一")})
	second := submit(t, s, d.Doc.ID, "same", protocol.DocOpInsertBlock{Block: para("a", "V", "一")})
	if first.Seq != 1 || second.Seq != 1 || second.Results[0].Status != protocol.DocOpStatusApplied || len(second.Blocks) != 1 {
		t.Fatalf("first %+v second %+v", first, second)
	}
	snap, _ := s.Get(ctx, d.Doc.ID)
	if snap.Doc.Seq != 1 || len(snap.Blocks) != 1 || snap.Doc.Title != "没起名的文档" {
		t.Fatalf("%+v", snap)
	}
	other, _ := s.Create(ctx, "另一篇")
	if _, err := s.Submit(ctx, other.Doc.ID, protocol.DocOwner, protocol.DocSubmit{BatchID: "same"}); err == nil {
		t.Fatal("another doc's batch was answered")
	}
	if _, err := s.Submit(ctx, "nope", protocol.DocOwner, protocol.DocSubmit{BatchID: "x"}); !errors.As(err, new(protocol.Missing)) {
		t.Fatalf("no doc: %v", err)
	}
	// A block id is the doc's that has it.
	ack := submit(t, s, other.Doc.ID, "dup", protocol.DocOpInsertBlock{Block: para("a", "V", "撞了")})
	if ack.Results[0].Status != protocol.DocOpStatusRejected {
		t.Fatalf("%+v", ack.Results)
	}
}

// A stale update over someone else's change is a conflict: the block keeps theirs, mine is kept as a conflict revision.
func TestStaleUpdateIsAConflict(t *testing.T) {
	ctx := context.Background()
	s := open(t, ":memory:")
	d, _ := s.Create(ctx, "t")
	id := d.Doc.ID
	submit(t, s, id, "1", protocol.DocOpInsertBlock{Block: para("a", "V", "原来")})
	if _, r, err := s.UpdateText(ctx, id, "lab", "a", 1, "帮工改的"); err != nil || r.Status != protocol.DocOpStatusApplied || r.Rev != 2 {
		t.Fatalf("%+v %v", r, err)
	}
	ack := submit(t, s, id, "3", protocol.DocOpUpdateText{BlockID: "a", BaseRev: 1, Text: []protocol.DocSpan{span("我改的")}})
	r := ack.Results[0]
	if r.Status != protocol.DocOpStatusConflict || plain(r.Yours) != "我改的" || r.Rev != 2 || ack.Seq != 3 {
		t.Fatalf("%+v", ack)
	}
	snap, _ := s.Get(ctx, id)
	if texts(snap) != "帮工改的" || snap.Blocks[0].UpdatedBy != "lab" {
		t.Fatalf("%q by %s", texts(snap), snap.Blocks[0].UpdatedBy)
	}
	var kind string
	if err := s.db.QueryRow("select kind from doc_block_revision where block_id = 'a' and spans like '%我改的%'").Scan(&kind); err != nil || kind != "conflict" {
		t.Fatalf("mine not kept: %q %v", kind, err)
	}
	// A checkbox ticked since does not make my text stale.
	submit(t, s, id, "4", protocol.DocOpSetAttrs{BlockID: "a", Attrs: protocol.BlockAttrs{Checked: new(true)}})
	if ack := submit(t, s, id, "5", protocol.DocOpUpdateText{BlockID: "a", BaseRev: 2, Text: []protocol.DocSpan{span("接着改")}}); ack.Results[0].Status != protocol.DocOpStatusApplied {
		t.Fatalf("%+v", ack.Results)
	}
}

func TestImportAndExport(t *testing.T) {
	ctx := context.Background()
	s := open(t, ":memory:")
	snap, err := s.Import(ctx, "导入", sample, "lab")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Doc.Seq != 1 || len(snap.Blocks) != 17 || snap.Blocks[0].UpdatedBy != "lab" {
		t.Fatalf("seq %d, %d blocks", snap.Doc.Seq, len(snap.Blocks))
	}
	md, err := s.Markdown(ctx, snap.Doc.ID)
	if err != nil || md != sample {
		t.Fatalf("%v\n%s", err, md)
	}
	b, r, err := s.Append(ctx, snap.Doc.ID, "lab", protocol.BlockParagraph, protocol.BlockAttrs{}, "帮工写的 **一段**")
	if err != nil || r.Status != protocol.DocOpStatusApplied || b.Rev != 1 || len(b.Text) != 2 {
		t.Fatalf("%+v %+v %v", b, r, err)
	}
	if md, _ := s.Markdown(ctx, snap.Doc.ID); !strings.HasSuffix(md, "### 结尾\n\n帮工写的 **一段**\n") {
		t.Fatalf("%s", md)
	}
	if _, err := s.Get(ctx, "nope"); !errors.As(err, new(protocol.Missing)) {
		t.Fatal(err)
	}
	var n int
	_ = s.db.QueryRow("select count(*) from doc_change").Scan(&n)
	if n != 2 {
		t.Fatalf("%d changes", n)
	}
}
