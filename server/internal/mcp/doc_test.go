package mcp

import (
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
)

// A helper writes a document through its tools: the same ops as the owner's editor, written as its profile; a stale
// rewrite over the owner's change is not taken and says what the block has now.
func TestAHelperWritesADoc(t *testing.T) {
	w := open(t)
	w.MCP.who = func(token string) string { return token }
	w.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w1", Name: "一号", Agent: "lab", Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	d, err := w.Doc.Create(w.ctx, "周报")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(w.MCP.Handler())
	defer server.Close()
	call := client(t, server.URL, "w1")
	tool := func(name string, args map[string]any) string {
		return call("tools/call", map[string]any{"name": name, "arguments": args}).text()
	}

	added := tool("doc_append", map[string]any{"doc": d.Doc.ID, "text": "这周做完了**第一步**"})
	m := regexp.MustCompile(`加了一块〔(\S+)〕，第 (\d+) 版`).FindStringSubmatch(added)
	if m == nil {
		t.Fatalf("added %q", added)
	}
	block := m[1]
	if heading := tool("doc_append", map[string]any{"doc": d.Doc.ID, "text": "下周", "type": "heading", "level": 1}); !strings.Contains(heading, "加了一块") {
		t.Fatalf("heading %q", heading)
	}
	if bad := tool("doc_append", map[string]any{"doc": d.Doc.ID, "text": "x", "type": "table"}); !strings.Contains(bad, "没成：块的类型只能是") {
		t.Fatalf("bad type %q", bad)
	}
	read := tool("doc_read", map[string]any{"doc": d.Doc.ID})
	if !strings.Contains(read, "《周报》，2 块") || !strings.Contains(read, "〔"+block+" · 第 1 版 · paragraph〕这周做完了第一步") {
		t.Fatalf("read %q", read)
	}
	if updated := tool("doc_update", map[string]any{"doc": d.Doc.ID, "block": block, "base_rev": 1, "text": "这周做完了第一步和第二步"}); !strings.Contains(updated, "现在是第 2 版") {
		t.Fatalf("updated %q", updated)
	}
	// The owner changes it in the editor; the helper's next rewrite was made against rev 2.
	if _, err := w.Doc.Submit(w.ctx, d.Doc.ID, protocol.DocOwner, protocol.DocSubmit{BatchID: "owner", Ops: []protocol.DocOp{{Value: protocol.DocOpUpdateText{
		BlockID: block, BaseRev: 2, Text: []protocol.DocSpan{{T: "主人改过的"}},
	}}}}); err != nil {
		t.Fatal(err)
	}
	stale := tool("doc_update", map[string]any{"doc": d.Doc.ID, "block": block, "base_rev": 2, "text": "帮工又改"})
	if !strings.Contains(stale, "没改：这一块刚被别人改过，现在是第 3 版") || !strings.Contains(stale, "主人改过的") {
		t.Fatalf("stale %q", stale)
	}
	snap, _ := w.Doc.Get(w.ctx, d.Doc.ID)
	if snap.Blocks[0].Text[0].T != "主人改过的" || snap.Blocks[0].UpdatedBy != protocol.DocOwner || snap.Blocks[1].UpdatedBy != "lab" {
		t.Fatalf("%+v", snap.Blocks)
	}
	if md, _ := w.Doc.Markdown(w.ctx, d.Doc.ID); md != "主人改过的\n\n# 下周\n" {
		t.Fatalf("%q", md)
	}
	if missing := tool("doc_read", map[string]any{"doc": "nope"}); !strings.Contains(missing, "没成") {
		t.Fatalf("missing %q", missing)
	}
}
