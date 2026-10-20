package doc

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
)

func para(id, key, text string) protocol.Block {
	return protocol.Block{ID: id, DocID: "d", OrderKey: key, Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span(text)}, Rev: 1, UpdatedBy: "owner"}
}

func op(v protocol.DocOpValue) protocol.DocOp { return protocol.DocOp{Value: v} }

// The text each block had at each rev, as the revisions keep it.
func withHistory(p *page, history map[string]map[int64]string) *page {
	p.base = func(block string, rev int64) ([]protocol.DocSpan, bool) {
		t, ok := history[block][rev]
		return []protocol.DocSpan{span(t)}, ok
	}
	return p
}

func TestOps(t *testing.T) {
	under := func(b protocol.Block, parent string) protocol.Block { b.ParentID = &parent; return b }
	for _, c := range []struct {
		name    string
		blocks  []protocol.Block
		history map[string]map[int64]string
		ops     []protocol.DocOpValue
		status  []protocol.DocOpStatus
		// Each live block in order: id=text.
		want string
	}{
		{
			name:   "insert",
			blocks: []protocol.Block{para("a", "V", "一")},
			ops:    []protocol.DocOpValue{protocol.DocOpInsertBlock{Block: para("b", "W", "二")}},
			status: []protocol.DocOpStatus{"applied"},
			want:   "a=一 b=二",
		},
		{
			name:   "insert refused",
			blocks: []protocol.Block{para("a", "V", "一")},
			ops: []protocol.DocOpValue{
				protocol.DocOpInsertBlock{Block: para("a", "W", "重名")},
				protocol.DocOpInsertBlock{Block: protocol.Block{ID: "x", OrderKey: "W", Type: "table"}},
				protocol.DocOpInsertBlock{Block: para("y", "W0", "坏键")},
			},
			status: []protocol.DocOpStatus{"rejected", "rejected", "rejected"},
			want:   "a=一",
		},
		{
			name:   "update",
			blocks: []protocol.Block{para("a", "V", "一")},
			ops:    []protocol.DocOpValue{protocol.DocOpUpdateText{BlockID: "a", BaseRev: 1, Text: []protocol.DocSpan{span("一二")}}},
			status: []protocol.DocOpStatus{"applied"},
			want:   "a=一二",
		},
		{
			name:    "stale update, someone else changed the text: conflict, theirs kept",
			blocks:  []protocol.Block{{ID: "a", OrderKey: "V", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span("别人的")}, Rev: 3}},
			history: map[string]map[int64]string{"a": {2: "原来的", 3: "别人的"}},
			ops:     []protocol.DocOpValue{protocol.DocOpUpdateText{BlockID: "a", BaseRev: 2, Text: []protocol.DocSpan{span("我的")}}},
			status:  []protocol.DocOpStatus{"conflict"},
			want:    "a=别人的",
		},
		{
			name: "stale update, only its attrs changed since: taken",
			blocks: []protocol.Block{{ID: "a", OrderKey: "V", Type: protocol.BlockTodo, Text: []protocol.DocSpan{span("买菜")}, Rev: 3,
				Attrs: protocol.BlockAttrs{Checked: new(true)}}},
			history: map[string]map[int64]string{"a": {2: "买菜", 3: "买菜"}},
			ops:     []protocol.DocOpValue{protocol.DocOpUpdateText{BlockID: "a", BaseRev: 2, Text: []protocol.DocSpan{span("买菜和米")}}},
			status:  []protocol.DocOpStatus{"applied"},
			want:    "a=买菜和米",
		},
		{
			name:   "split mid-text",
			blocks: []protocol.Block{para("a", "V", "你好👍世界")},
			ops:    []protocol.DocOpValue{protocol.DocOpSplitBlock{BlockID: "a", BaseRev: 1, Offset: 3, NewBlock: para("b", "W", "")}},
			status: []protocol.DocOpStatus{"applied"},
			want:   "a=你好👍 b=世界",
		},
		{
			name:    "split against a changed text: split at its end, conflict",
			blocks:  []protocol.Block{{ID: "a", OrderKey: "V", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span("改过了")}, Rev: 2}},
			history: map[string]map[int64]string{"a": {1: "原来", 2: "改过了"}},
			ops:     []protocol.DocOpValue{protocol.DocOpSplitBlock{BlockID: "a", BaseRev: 1, Offset: 1, NewBlock: para("b", "W", "")}},
			status:  []protocol.DocOpStatus{"conflict"},
			want:    "a=改过了 b=",
		},
		{
			name:   "split out of range",
			blocks: []protocol.Block{para("a", "V", "短")},
			ops:    []protocol.DocOpValue{protocol.DocOpSplitBlock{BlockID: "a", BaseRev: 1, Offset: 5, NewBlock: para("b", "W", "")}},
			status: []protocol.DocOpStatus{"rejected"},
			want:   "a=短",
		},
		{
			name:   "merge: the source's text and children go to the target",
			blocks: []protocol.Block{para("a", "V", "前"), para("b", "W", "后"), under(para("c", "V", "子"), "b")},
			ops:    []protocol.DocOpValue{protocol.DocOpMergeBlocks{TargetID: "a", SourceID: "b"}},
			status: []protocol.DocOpStatus{"applied"},
			want:   "a=前后 c=子",
		},
		{
			name:   "merge a deleted source: noop",
			blocks: []protocol.Block{para("a", "V", "前"), {ID: "b", OrderKey: "W", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span("后")}, Rev: 2, Deleted: true}},
			ops:    []protocol.DocOpValue{protocol.DocOpMergeBlocks{TargetID: "a", SourceID: "b"}},
			status: []protocol.DocOpStatus{"noop"},
			want:   "a=前",
		},
		{
			name:   "delete takes the children; restore brings them back",
			blocks: []protocol.Block{para("a", "V", "父"), under(para("b", "V", "子"), "a"), para("c", "W", "旁")},
			ops: []protocol.DocOpValue{
				protocol.DocOpDeleteBlock{BlockID: "a"},
				protocol.DocOpUpdateText{BlockID: "b", BaseRev: 2, Text: []protocol.DocSpan{span("改删掉的")}},
				protocol.DocOpDeleteBlock{BlockID: "a"},
			},
			status: []protocol.DocOpStatus{"applied", "conflict", "noop"},
			want:   "c=旁",
		},
		{
			name:   "restore",
			blocks: []protocol.Block{{ID: "a", OrderKey: "V", Type: protocol.BlockParagraph, Text: []protocol.DocSpan{span("回来")}, Rev: 2, Deleted: true}},
			ops:    []protocol.DocOpValue{protocol.DocOpRestoreBlock{BlockID: "a"}},
			status: []protocol.DocOpStatus{"applied"},
			want:   "a=回来",
		},
		{
			name:   "move: under itself is refused, under a deleted parent goes to its level",
			blocks: []protocol.Block{para("a", "V", "一"), under(para("b", "V", "二"), "a"), {ID: "x", OrderKey: "X", Type: protocol.BlockParagraph, Rev: 2, Deleted: true}},
			ops: []protocol.DocOpValue{
				protocol.DocOpMoveBlock{BlockID: "a", ParentID: new("b"), OrderKey: "V"},
				protocol.DocOpMoveBlock{BlockID: "b", ParentID: new("x"), OrderKey: "U"},
			},
			status: []protocol.DocOpStatus{"rejected", "applied"},
			want:   "b=二 a=一",
		},
		{
			name: "set attrs and type",
			blocks: []protocol.Block{{ID: "a", OrderKey: "V", Type: protocol.BlockTodo, Text: []protocol.DocSpan{bold("字")}, Rev: 1,
				Attrs: protocol.BlockAttrs{Checked: new(false)}}},
			ops: []protocol.DocOpValue{
				protocol.DocOpSetAttrs{BlockID: "a", Attrs: protocol.BlockAttrs{Checked: new(true)}},
				protocol.DocOpSetAttrs{BlockID: "a", Unset: []string{"nope"}},
				protocol.DocOpSetType{BlockID: "a", Type: protocol.BlockCode, Attrs: protocol.BlockAttrs{Language: new("go")}},
				protocol.DocOpSetType{BlockID: "a", Type: "table"},
			},
			status: []protocol.DocOpStatus{"applied", "rejected", "applied", "rejected"},
			want:   "a=字",
		},
		{
			name:   "a type without text drops it",
			blocks: []protocol.Block{para("a", "V", "---")},
			ops:    []protocol.DocOpValue{protocol.DocOpSetType{BlockID: "a", Type: protocol.BlockDivider}},
			status: []protocol.DocOpStatus{"applied"},
			want:   "a=",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := withHistory(newPage("d", "lab", 9, c.blocks), c.history)
			for i, o := range c.ops {
				r := p.apply(op(o))
				if r.Status != c.status[i] {
					t.Fatalf("op %d (%T): %s %s", i, o, r.Status, r.Reason)
				}
			}
			var all []protocol.Block
			for _, b := range p.blocks {
				all = append(all, *b)
			}
			var got []string
			for _, b := range ordered(all) {
				got = append(got, b.ID+"="+plain(b.Text))
			}
			if strings.Join(got, " ") != c.want {
				t.Fatalf("blocks %q, want %q", strings.Join(got, " "), c.want)
			}
		})
	}
}

func TestChangedBlocksCarryTheirRevAndWriter(t *testing.T) {
	p := newPage("d", "lab", 9, []protocol.Block{para("a", "V", "你好")})
	p.apply(op(protocol.DocOpSplitBlock{BlockID: "a", BaseRev: 1, Offset: 1, NewBlock: para("b", "W", "")}))
	changed := p.changedBlocks()
	if len(changed) != 2 || changed[0].Rev != 2 || changed[1].Rev != 1 || changed[1].UpdatedBy != "lab" || changed[0].Updated != 9 {
		t.Fatalf("%+v", changed)
	}
	if len(p.revisions) != 2 || p.revisions[0].rev != 2 || plain(p.revisions[0].spans) != "你" {
		t.Fatalf("revisions %+v", p.revisions)
	}
	if p.changedBlocks()[0].Text[0].Marks.Code {
		t.Fatal("marks")
	}
}

// Every op the protocol has is handled: a new member fails here until apply knows it.
func TestEveryOpIsHandled(t *testing.T) {
	for _, m := range protocol.DocOpMembers {
		r := newPage("d", "owner", 1, nil).apply(op(m))
		if strings.HasPrefix(r.Reason, "不认识的改动") {
			t.Errorf("%T is not handled", m)
		}
	}
}

func TestCodeHasNoMarks(t *testing.T) {
	p := newPage("d", "owner", 1, nil)
	b := para("c", "V", "")
	b.Type, b.Text = protocol.BlockCode, []protocol.DocSpan{bold("x := 1")}
	p.apply(op(protocol.DocOpInsertBlock{Block: b}))
	if got := p.blocks["c"].Text; len(got) != 1 || got[0].Marks.Bold {
		t.Fatalf("%v", got)
	}
}
