package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

// Nowledge Mem played over MCP: memory_search and memory_add as its tools/list gives them (2026-10-18, 0.10.103), on what it
// was given; any other tool it has (memory_delete here) must never be called. As the real one does, a search without a query
// finds nothing, and with labels to filter by any query finds all they hold ("*" here).
type fakeNowledge struct {
	mu       sync.Mutex
	memories []fakeNowledgeMemory
	searches []map[string]any
	adds     []map[string]any
	others   []string
}

type fakeNowledgeMemory struct {
	id, title, content string
	labels             []string
}

func (n *fakeNowledge) serve(t *testing.T) string {
	t.Helper()
	server := sdk.NewServer(&sdk.Implementation{Name: "nowledge-mem", Version: "0.10.103"}, nil)
	object := map[string]any{"type": "object"}
	args := func(req *sdk.CallToolRequest) map[string]any {
		var a map[string]any
		_ = json.Unmarshal(req.Params.Arguments, &a)
		return a
	}
	text := func(v any) *sdk.CallToolResult {
		body, _ := json.Marshal(v)
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(body)}}}
	}
	server.AddTool(&sdk.Tool{Name: "memory_search", InputSchema: object}, func(_ context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		a := args(req)
		n.mu.Lock()
		defer n.mu.Unlock()
		n.searches = append(n.searches, a)
		query, _ := a["query"].(string)
		label, _ := a["filter_labels"].(string)
		results := []map[string]any{}
		for _, m := range slices.Backward(n.memories) {
			if label != "" && !slices.Contains(m.labels, label) {
				continue
			}
			if query == "" || query != "*" && !strings.Contains(m.content, query) && !strings.Contains(m.title, query) {
				continue
			}
			results = append(results, map[string]any{"id": m.id, "memory_id": m.id, "title": m.title, "content": m.content, "content_preview": m.content, "relevance_score": 0.9})
		}
		return text(map[string]any{"results": results, "total": len(results), "query": query}), nil
	})
	server.AddTool(&sdk.Tool{Name: "memory_add", InputSchema: object}, func(_ context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		a := args(req)
		n.mu.Lock()
		defer n.mu.Unlock()
		n.adds = append(n.adds, a)
		labels, _ := a["labels"].(string)
		content, _ := a["content"].(string)
		title, _ := a["title"].(string)
		m := fakeNowledgeMemory{id: fmt.Sprintf("nm-%d", len(n.memories)+1), title: title, content: content, labels: strings.Split(labels, ",")}
		n.memories = append(n.memories, m)
		return text(map[string]any{"id": m.id, "title": title}), nil
	})
	server.AddTool(&sdk.Tool{Name: "memory_delete", InputSchema: object}, func(_ context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		n.mu.Lock()
		defer n.mu.Unlock()
		n.others = append(n.others, req.Params.Name)
		return text(map[string]any{"deleted": true}), nil
	})
	web := httptest.NewServer(sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, nil))
	t.Cleanup(web.Close)
	return web.URL + "/mcp/"
}

func (n *fakeNowledge) seen() (searches, adds []map[string]any, others []string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return slices.Clone(n.searches), slices.Clone(n.adds), slices.Clone(n.others)
}

func withSource(t *testing.T, s protocol.MemorySourceUpdate) *world {
	t.Helper()
	f := memoryWorld(t)
	if _, err := f.Setting.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{s}}); err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return f
}

func TestARunsNotesReachNowledgeAndComeBack(t *testing.T) {
	fake := &fakeNowledge{}
	f := withSource(t, protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: fake.serve(t), Enabled: true, Read: true, Write: true})
	f.Memory.Keep(FinishedRun{Agent: "lab", Session: "w1", Project: "demo", Job: "修登录页", Outcome: protocol.OutcomeCompleted, Summary: "改好了",
		Said: "改好了。\n记住：测试前要 export DEEPSEEK_API_KEY=sk-abcdefghijklmnop1234\n记住（所有项目）：提交信息写中文"})
	adds := testkit.Await(t, "both notes in Nowledge", func() ([]map[string]any, bool) {
		_, adds, _ := fake.seen()
		return adds, len(adds) == 2
	})
	if adds[0]["content"] != "测试前要 export DEEPSEEK_API_KEY=[redacted]" || adds[0]["labels"] != "vibevalley,vibevalley-agent-lab,vibevalley-project-demo" || adds[0]["source_app"] != "vibevalley" {
		t.Fatalf("sent %v", adds[0])
	}
	if adds[1]["labels"] != "vibevalley,vibevalley-agent-lab" {
		t.Fatalf("a note for every project is labelled without one: %v", adds[1])
	}

	got := f.Memory.Recall(RecallCue{Agent: "lab", Session: "w2", Project: "demo", Text: "测试"})
	if !slices.Contains(got.IDs, "nowledge:nm-1") || !slices.ContainsFunc(got.Lines, func(l string) bool { return strings.HasPrefix(l, "- （Nowledge）测试前要") }) {
		t.Fatalf("recalled %+v", got)
	}
	searches, _, _ := fake.seen()
	if last := searches[len(searches)-1]; last["filter_labels"] != "vibevalley-agent-lab" || last["query"] != "测试" {
		t.Fatalf("searched with %v", last)
	}

	if found := f.Memory.Search(SearchQuery{Agent: "lab", Text: "提交"}); len(found) != 1 || found[0].Source != localName {
		t.Fatalf("the same note from both is found once: %+v", found)
	}
	fake.mu.Lock()
	fake.memories = append(fake.memories, fakeNowledgeMemory{id: "nm-9", title: "部署", content: "部署用 make deploy", labels: []string{"vibevalley-agent-lab"}})
	fake.mu.Unlock()
	found := f.Memory.Search(SearchQuery{Agent: "lab", Text: "部署"})
	if len(found) != 1 || found[0].Source != nowledgeName || found[0].ID != "nowledge:nm-9" {
		t.Fatalf("found %+v", found)
	}
	if text := FoundText(found, SearchQuery{Agent: "lab", Text: "部署"}); !strings.Contains(text, "- （Nowledge Mem）部署用 make deploy〔nowledge:nm-9〕") {
		t.Fatalf("answered %q", text)
	}

	listed := f.Memory.MemoriesOf("lab")
	fromNowledge := slices.IndexFunc(listed.Memories, func(m protocol.Memory) bool { return ptr.Value(m.Source) == nowledgeName })
	if fromNowledge < 0 || len(listed.Sources) != 2 || !listed.Sources[1].CanList || listed.Sources[1].CanForget {
		t.Fatalf("the tab gets %+v", listed)
	}
	if err := f.Memory.Forget("lab", listed.Memories[fromNowledge].ID); err == nil {
		t.Fatal("forgot a memory in the owner's Nowledge")
	}
	if _, _, others := fake.seen(); len(others) != 0 {
		t.Fatalf("called %v", others)
	}
}

func TestNowledgeReadsEverythingOnlyWhenTold(t *testing.T) {
	fake := &fakeNowledge{memories: []fakeNowledgeMemory{{id: "own-1", title: "主人的偏好", content: "测试要写成可观察的结果"}}}
	url := fake.serve(t)
	f := withSource(t, protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: url, Enabled: true, Read: true})
	if got := f.Memory.Search(SearchQuery{Agent: "lab", Text: "测试"}); len(got) != 0 {
		t.Fatalf("read the owner's own without being told: %+v", got)
	}
	if _, err := f.Setting.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{{Kind: protocol.MemorySourceKindNowledge, URL: url, Enabled: true, Read: true, Everything: true}}}); err != nil {
		t.Fatal(err)
	}
	got := f.Memory.Search(SearchQuery{Agent: "lab", Text: "测试"})
	if len(got) != 1 || got[0].Text != "主人的偏好：测试要写成可观察的结果" {
		t.Fatalf("found %+v", got)
	}
	f.Memory.Write(Note{Agent: "lab", Text: "不写进去", Project: "", By: protocol.MemoryAuthorOwner})
	time.Sleep(50 * time.Millisecond)
	if _, adds, _ := fake.seen(); len(adds) != 0 {
		t.Fatalf("wrote with Write off: %v", adds)
	}
}

func TestANowledgeThatDoesNotAnswerIsSkipped(t *testing.T) {
	hung := make(chan struct{})
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-hung }))
	t.Cleanup(func() { close(hung); web.Close() })
	f := memoryWorld(t)
	f.Memory.timeout = 100 * time.Millisecond
	if _, err := f.Setting.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{{Kind: protocol.MemorySourceKindNowledge, URL: web.URL, Enabled: true, Read: true}}}); err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	if _, err := f.Memory.Write(Note{Agent: "lab", Text: "迁移文件放 db/migrations", Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	logged := captureLog(t)
	start := time.Now()
	got := f.Memory.Recall(RecallCue{Agent: "lab", Project: "demo", Text: "迁移"})
	if took := time.Since(start); took > time.Second || len(got.Lines) != 1 {
		t.Fatalf("waited %s, recalled %+v", took, got)
	}
	if !strings.Contains(logged(), "memory from nowledge took longer than 100ms; lab goes on without it") {
		t.Fatalf("logged %q", logged())
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func captureLog(t *testing.T) func() string {
	out := &lockedBuffer{}
	log.SetOutput(out)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	return func() string {
		out.mu.Lock()
		defer out.mu.Unlock()
		return out.b.String()
	}
}
