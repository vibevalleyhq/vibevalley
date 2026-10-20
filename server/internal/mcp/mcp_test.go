package mcp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
)

type rpcAnswer struct {
	Result *struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	} `json:"result"`
	Error json.RawMessage `json:"error"`
}

func (a rpcAnswer) text() string {
	if a.Result == nil {
		return ""
	}
	var out strings.Builder
	for _, c := range a.Result.Content {
		out.WriteString(c.Text)
	}
	return out.String()
}

func client(t *testing.T, url, token string) func(method string, params any) rpcAnswer {
	t.Helper()
	session := ""
	id := 0
	post := func(body map[string]any) (*http.Response, []byte) {
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("accept", "application/json, text/event-stream")
		if token != "" {
			req.Header.Set("authorization", "Bearer "+token)
		}
		if session != "" {
			req.Header.Set("mcp-session-id", session)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		if s := res.Header.Get("mcp-session-id"); s != "" {
			session = s
		}
		return res, raw
	}
	call := func(method string, params any) rpcAnswer {
		id++
		res, raw := post(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		body := raw
		if strings.Contains(res.Header.Get("content-type"), "text/event-stream") {
			body = nil
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.HasPrefix(line, "data:") {
					body = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				}
			}
		}
		var answer rpcAnswer
		if err := json.Unmarshal(body, &answer); err != nil {
			t.Fatalf("%s: %v: %s", method, err, raw)
		}
		return answer
	}
	init := call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "test", "version": "0"}})
	if init.Result == nil {
		t.Fatalf("initialize answered: %s", init.Error)
	}
	post(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	return call
}

func TestToolsOverMcp(t *testing.T) {
	w := open(t)
	f := w
	hired := f.Issue.Hire(w.ctx, fixture.Lab(t), "写 hello", "chat-j", session.HireOptions{})
	if hired.Session == nil {
		t.Fatalf("not hired: %s", hired.Refused)
	}
	id := hired.Session.ID
	token := testkit.Await(t, "the session's token", func() (string, bool) {
		w.mu.Lock()
		defer w.mu.Unlock()
		for _, tk := range w.tokens {
			return tk, true
		}
		return "", false
	})
	thread := testkit.Await(t, "its job thread", func() (protocol.Conversation, bool) {
		tid := f.Channel.JobThread(id)
		if tid == nil {
			return protocol.Conversation{}, false
		}
		c := protocol.ConversationOf(f.Core.State().Chat, *tid)
		if c == nil {
			return protocol.Conversation{}, false
		}
		return *c, true
	})
	server := httptest.NewServer(f.MCP.Handler())
	t.Cleanup(server.Close)
	url := server.URL + "/mcp"

	call := client(t, url, token)
	var names []string
	for _, tool := range call("tools/list", map[string]any{}).Result.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	if !slices.Equal(names, []string{"channel_inbox", "channel_say", "doc_append", "doc_read", "doc_update", "issue_split", "memory_add", "memory_search", "read_chat", "session_list"}) {
		t.Fatalf("tools %q", names)
	}

	who := call("tools/call", map[string]any{"name": "session_list", "arguments": map[string]any{}}).text()
	if !regexp.MustCompile(`(?m)^- ` + id + ` `).MatchString(who) {
		t.Fatalf("who %q", who)
	}
	lines := strings.Split(who, "\n")
	if strings.Contains(strings.Join(lines[:len(lines)-1], "\n"), "@") {
		t.Fatal("names are listed with an @, and models copy a wake")
	}
	if said := call("tools/call", map[string]any{"name": "channel_say", "arguments": map[string]any{"text": "从 MCP 说一句", "anyway": true}}).text(); !strings.Contains(said, "发出去了") {
		t.Fatalf("said %q", said)
	}
	i := slices.IndexFunc(protocol.MessagesIn(f.Core.State().Chat, thread.ID), func(m protocol.ChatMessage) bool { return m.Text == "从 MCP 说一句" })
	if i < 0 {
		t.Fatal("not in its job thread")
	}
	if m := protocol.MessagesIn(f.Core.State().Chat, thread.ID)[i]; m.From != id || m.FromKind != protocol.SenderKindAgent {
		t.Fatalf("said as %s (%s)", m.From, m.FromKind)
	}
	if inbox := call("tools/call", map[string]any{"name": "channel_inbox", "arguments": map[string]any{}}).text(); inbox == "" {
		t.Fatal("no answer from the inbox")
	}
	if read := call("tools/call", map[string]any{"name": "read_chat", "arguments": map[string]any{}}).text(); !strings.Contains(read, "从 MCP 说一句") {
		t.Fatalf("read %q", read)
	}

	if text := client(t, url, "")("tools/call", map[string]any{"name": "session_list", "arguments": map[string]any{}}).text(); !strings.Contains(text, "没认出你是谁") {
		t.Fatalf("no token: %q", text)
	}
	if text := client(t, url, "hb_w1_forged")("tools/call", map[string]any{"name": "channel_say", "arguments": map[string]any{"text": "冒名"}}).text(); !strings.Contains(text, "没认出你是谁") {
		t.Fatalf("forged: %q", text)
	}
}

func TestSessionListUsesDomainPhaseDescriptions(t *testing.T) {
	w := open(t)
	w.MCP.who = func(string) string { return "caller" }
	for _, h := range []protocol.Session{
		{ID: "failed", Name: "失败的", Phase: protocol.Phase{Value: protocol.PhaseFailed{}}},
		{ID: "resting", Name: "歇着的", Phase: protocol.Phase{Value: protocol.PhaseResting{}}},
		{ID: "ripe", Name: "冲突的", Phase: protocol.Phase{Value: protocol.PhaseRipe{}}, Conflict: &protocol.Conflict{Base: "main", Files: []string{"a.go"}}},
	} {
		w.Core.Apply(protocol.FactHired{Session: h})
	}
	server := httptest.NewServer(w.MCP.Handler())
	defer server.Close()
	call := client(t, server.URL, "token")
	text := call("tools/call", map[string]any{"name": "session_list", "arguments": map[string]any{}}).text()
	for _, want := range []string{"这一轮失败了", "歇着（上一轮没做完）", "合进 main 会冲突（a.go）"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
}

func TestEveryMcpToolRequiresAuthenticatedSession(t *testing.T) {
	w := open(t)
	server := httptest.NewServer(w.MCP.Handler())
	defer server.Close()
	call := client(t, server.URL, "")
	for _, tool := range call("tools/list", map[string]any{}).Result.Tools {
		t.Run(tool.Name, func(t *testing.T) {
			args := map[string]any{}
			if tool.Name == "channel_say" || tool.Name == "memory_add" {
				args["text"] = "must not be posted"
			}
			text := call("tools/call", map[string]any{"name": tool.Name, "arguments": args}).text()
			if !strings.Contains(text, "没认出你是谁") {
				t.Fatalf("unauthenticated result: %s", text)
			}
		})
	}
}

func TestAHelperSearchesAndWritesOnlyItsOwnMemory(t *testing.T) {
	w := open(t)
	w.MCP.who = func(token string) string { return token }
	demo := "demo"
	w.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w1", Name: "一号", Agent: "lab", Project: &demo, Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	if _, err := w.Memory.Write(memory.Note{Agent: "scout", Text: "这个项目测试用 make check", Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(w.MCP.Handler())
	defer server.Close()
	call := client(t, server.URL, "w1")
	tool := func(name string, args map[string]any) string {
		return call("tools/call", map[string]any{"name": name, "arguments": args}).text()
	}

	if added := tool("memory_add", map[string]any{"text": "这个项目测试用 pnpm test"}); !strings.Contains(added, "记下了（项目 demo）") {
		t.Fatalf("added %q", added)
	}
	if added := tool("memory_add", map[string]any{"text": "提交信息写中文", "all_projects": true}); !strings.Contains(added, "记下了（所有项目）") {
		t.Fatalf("added %q", added)
	}
	if refused := tool("memory_add", map[string]any{"text": "冒名记一条", "agent": "scout"}); !strings.Contains(refused, "只能记进你自己的档案") {
		t.Fatalf("wrote another profile: %q", refused)
	}
	for _, m := range w.Memory.List("scout") {
		if m.Text == "冒名记一条" {
			t.Fatal("it reached scout's memory")
		}
	}
	// What it wrote is its own, not the owner's: the 记性 tab says which helper wrote it.
	for _, m := range w.Memory.List("lab") {
		if m.Author == nil || *m.Author != protocol.MemoryAuthorAgent || m.Session == nil || *m.Session != "w1" {
			t.Fatalf("a helper's note reads as written by %v (session %v)", m.Author, m.Session)
		}
	}
	found := tool("memory_search", map[string]any{"query": "测试"})
	if !strings.Contains(found, "pnpm test") || strings.Contains(found, "make check") {
		t.Fatalf("found %q", found)
	}
	if none := tool("memory_search", map[string]any{"query": "部署"}); !strings.Contains(none, "没有搜到「部署」") {
		t.Fatalf("found %q", none)
	}
	if away := client(t, server.URL, "w9")("tools/call", map[string]any{"name": "memory_search", "arguments": map[string]any{"query": "测试"}}).text(); !strings.Contains(away, "地里没有你") {
		t.Fatalf("a session not on the farm: %q", away)
	}
}
