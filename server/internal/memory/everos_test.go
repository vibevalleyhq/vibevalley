package memory

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

// EverOS's /api/v2 played: every request as it came, and a search that answers with one case and one episode.
type fakeEveros struct {
	mu       sync.Mutex
	requests []fakeEverosRequest
}

type fakeEverosRequest struct {
	path, auth string
	body       map[string]any
}

func (e *fakeEveros) serve(t *testing.T) string {
	t.Helper()
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		e.mu.Lock()
		e.requests = append(e.requests, fakeEverosRequest{r.URL.Path, r.Header.Get("Authorization"), body})
		e.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v2/memory/search":
			data := map[string]any{"agent_cases": []any{map[string]any{"id": "case-1", "task_intent": "给打卡接口加分页", "approach": "先跑 pnpm test", "key_insight": "分页参数从 1 开始", "score": 0.8}}}
			if body["user_id"] != nil {
				data = map[string]any{"episodes": []any{map[string]any{"id": "ep-1", "subject": "登录页", "summary": "主人让修登录页，改完了", "score": 0.7}}}
			}
			json.NewEncoder(w).Encode(map[string]any{"request_id": "r1", "data": data})
		case "/api/v2/memory/add", "/api/v2/memory/flush":
			json.NewEncoder(w).Encode(map[string]any{"request_id": "r2", "data": map[string]any{}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(web.Close)
	return web.URL
}

func (e *fakeEveros) seen(path string) []fakeEverosRequest {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.DeleteFunc(slices.Clone(e.requests), func(r fakeEverosRequest) bool { return r.path != "/api/v2/memory/"+path })
}

func TestEverosGetsRunsAndExtractsWhenTheSessionEnds(t *testing.T) {
	fake := &fakeEveros{}
	f := withSource(t, protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindEveros, URL: fake.serve(t) + "/", Enabled: true, Read: true, Write: true, User: "lucas", Key: new("ev-key-1234")})
	f.Memory.Keep(FinishedRun{Agent: "lab", Session: "w1", Project: "demo", Job: "修登录页，token 是 sk-abcdefghijklmnop1234", Outcome: protocol.OutcomeCompleted, Said: "改好了。\n记住：登录态统一走 refreshSession()", Summary: "改好了"})
	f.Memory.Keep(FinishedRun{Agent: "lab", Session: "w1", Project: "demo", Job: "修登录页", Outcome: protocol.OutcomeFailed, Said: "测试没过", Summary: "测试没过"})
	f.Memory.Keep(FinishedRun{Agent: "lab", Session: "w1", Project: "demo", Job: "修登录页", Outcome: protocol.OutcomeInterrupted, Said: "停下了"})
	adds := testkit.Await(t, "both runs at EverOS", func() ([]fakeEverosRequest, bool) {
		adds := fake.seen("add")
		return adds, len(adds) == 2
	})
	first, _ := json.Marshal(adds[0].body)
	for _, want := range []string{`"session_id":"vibevalley-w1"`, `"app_id":"vibevalley"`, `"project_id":"demo"`, `"role":"user","sender_id":"lucas"`, `token 是 [redacted]`, `"role":"assistant","sender_id":"vibevalley-lab"`, `refreshSession()`} {
		if !strings.Contains(string(first), want) {
			t.Fatalf("the first run went as %s, without %s", first, want)
		}
	}
	if adds[0].auth != "Bearer ev-key-1234" {
		t.Fatalf("authorized as %q", adds[0].auth)
	}
	second, _ := json.Marshal(adds[1].body["messages"])
	if strings.Contains(string(second), `"role":"user"`) || !strings.Contains(string(second), "（这一轮没做成）测试没过") {
		t.Fatalf("the second run went as %s: the job once, and a failure said", second)
	}
	if len(fake.seen("flush")) != 0 {
		t.Fatal("flushed before the session ended")
	}
	f.Memory.EndSession(EndedSession{Agent: "lab", Session: "w1", Project: "demo"})
	f.Memory.EndSession(EndedSession{Agent: "lab", Session: "w2", Project: "demo"})
	flushes := testkit.Await(t, "the flush", func() ([]fakeEverosRequest, bool) {
		flushes := fake.seen("flush")
		return flushes, len(flushes) == 1
	})
	if flushes[0].body["session_id"] != "vibevalley-w1" || flushes[0].body["project_id"] != "demo" {
		t.Fatalf("flushed %v: only the session it was given", flushes[0].body)
	}

	got := f.Memory.Recall(RecallCue{Agent: "lab", Session: "w3", Project: "demo", Text: "分页"})
	if !slices.Contains(got.IDs, "everos:case-1") || !slices.Contains(got.Lines, "- （EverOS）给打卡接口加分页；先跑 pnpm test；分页参数从 1 开始") {
		t.Fatalf("recalled %+v", got)
	}
	searches := fake.seen("search")
	if q := searches[0].body; q["agent_id"] != "vibevalley-lab" || q["query"] != "分页" || q["user_id"] != nil {
		t.Fatalf("searched with %v", q)
	}
	found := f.Memory.Search(SearchQuery{Agent: "lab", Text: "登录", Kind: protocol.MemoryKindIssue})
	if !slices.ContainsFunc(found, func(m Found) bool {
		return m.ID == "everos:ep-1" && m.Text == "登录页：主人让修登录页，改完了"
	}) {
		t.Fatalf("episodes: %+v", found)
	}
	if found := f.Memory.Search(SearchQuery{Text: "登录"}); slices.ContainsFunc(found, func(m Found) bool { return m.Source == everosName }) {
		t.Fatalf("a search over every profile has no one to ask EverOS for: %+v", found)
	}
	sources := f.Memory.Sources()
	if len(sources) != 2 || sources[1].Label != "EverOS" || sources[1].CanList || sources[1].CanForget || !sources[1].Transcripts {
		t.Fatalf("sources %+v", sources)
	}
}

func TestANoteOutsideARunIsExtractedAtOnce(t *testing.T) {
	fake := &fakeEveros{}
	f := withSource(t, protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindEveros, URL: fake.serve(t), Enabled: true, Read: true, Write: true})
	if _, err := f.Memory.Write("lab", "提交信息写中文", ""); err != nil {
		t.Fatal(err)
	}
	flushes := testkit.Await(t, "the note extracted", func() ([]fakeEverosRequest, bool) {
		flushes := fake.seen("flush")
		return flushes, len(flushes) == 1
	})
	add := fake.seen("add")[0]
	messages, _ := json.Marshal(add.body["messages"])
	if add.body["session_id"] != flushes[0].body["session_id"] || !strings.Contains(string(messages), `"role":"user","sender_id":"owner"`) ||
		!strings.Contains(string(messages), "记住（所有项目）：提交信息写中文") {
		t.Fatalf("sent %v, flushed %v", add.body, flushes[0].body)
	}
}

func TestEverosIsToldWhatIsLeftWhenTheFarmStops(t *testing.T) {
	fake := &fakeEveros{}
	f := withSource(t, protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindEveros, URL: fake.serve(t), Enabled: true, Write: true})
	f.Memory.Keep(FinishedRun{Agent: "lab", Session: "w7", Project: "demo", Job: "写文档", Outcome: protocol.OutcomeCompleted, Said: "写好了"})
	testkit.Await(t, "the run at EverOS", func() (bool, bool) { return true, len(fake.seen("add")) == 1 })
	f.Close()
	if flushes := fake.seen("flush"); len(flushes) != 1 || flushes[0].body["session_id"] != "vibevalley-w7" {
		t.Fatalf("flushed %v", flushes)
	}
}
