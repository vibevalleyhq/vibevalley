package manager

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

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
)

// The farm's tools over MCP (chat.test.ts's MCP part): a helper's session carries its token, and the token says who
// is talking. The client is plain JSON-RPC over HTTP, the way a runtime's makes it: initialize opens a session (its id
// comes back in a header and goes with every later call); each call answers as JSON or on an event stream.

type foremanRPCAnswer struct {
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

func (a foremanRPCAnswer) text() string {
	if a.Result == nil {
		return ""
	}
	var out strings.Builder
	for _, c := range a.Result.Content {
		out.WriteString(c.Text)
	}
	return out.String()
}

// foremanMcpClient opens an MCP session at url with the bearer token (none when empty); its call function.
func foremanMcpClient(t *testing.T, url, token string) func(method string, params any) foremanRPCAnswer {
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
	call := func(method string, params any) foremanRPCAnswer {
		id++
		res, raw := post(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		// A JSON-RPC answer, as plain JSON or as the last event of a stream.
		body := raw
		if strings.Contains(res.Header.Get("content-type"), "text/event-stream") {
			body = nil
			for _, line := range strings.Split(string(raw), "\n") {
				if strings.HasPrefix(line, "data:") {
					body = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
				}
			}
		}
		var answer foremanRPCAnswer
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

func TestFarmToolsOverMcp(t *testing.T) {
	w := foremanOpen(t)
	f := w.f
	w.enableLab(t)
	hired := f.Dispatch.Hire(w.ctx, farmtest.Lab(t), "写 hello", "chat-j", base.HireOptions{})
	if hired.Helper == nil {
		t.Fatalf("not hired: %s", hired.Refused)
	}
	id := hired.Helper.ID
	token := farmtest.Await(t, "the session's token", func() (string, bool) {
		w.mu.Lock()
		defer w.mu.Unlock()
		for _, tk := range w.tokens {
			return tk, true
		}
		return "", false
	})
	thread := farmtest.Await(t, "its job thread", func() (protocol.Conversation, bool) {
		c := protocol.JobThreadOf(f.Site.State().Chat, id)
		if c == nil {
			return protocol.Conversation{}, false
		}
		return *c, true
	})
	server := httptest.NewServer(f.FarmTools.Handler())
	t.Cleanup(server.Close)
	url := server.URL + "/mcp"

	mcp := foremanMcpClient(t, url, token)
	var names []string
	for _, tool := range mcp("tools/list", map[string]any{}).Result.Tools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	if !slices.Equal(names, []string{"farm_inbox", "farm_read", "farm_say", "farm_who"}) {
		t.Fatalf("tools %q", names)
	}

	who := mcp("tools/call", map[string]any{"name": "farm_who", "arguments": map[string]any{}}).text()
	if !regexp.MustCompile(`(?m)^- ` + id + ` `).MatchString(who) {
		t.Fatalf("who %q", who)
	}
	lines := strings.Split(who, "\n")
	if strings.Contains(strings.Join(lines[:len(lines)-1], "\n"), "@") {
		t.Fatal("names are listed with an @, and models copy a wake")
	}
	if said := mcp("tools/call", map[string]any{"name": "farm_say", "arguments": map[string]any{"text": "从 MCP 说一句", "anyway": true}}).text(); !strings.Contains(said, "发出去了") {
		t.Fatalf("said %q", said)
	}
	i := slices.IndexFunc(protocol.MessagesIn(f.Site.State().Chat, thread.ID), func(m protocol.ChatMessage) bool { return m.Text == "从 MCP 说一句" })
	if i < 0 {
		t.Fatal("not in its job thread")
	}
	if m := protocol.MessagesIn(f.Site.State().Chat, thread.ID)[i]; m.From != id || m.FromKind != protocol.SenderKindHelper {
		t.Fatalf("said as %s (%s)", m.From, m.FromKind)
	}
	if inbox := mcp("tools/call", map[string]any{"name": "farm_inbox", "arguments": map[string]any{}}).text(); inbox == "" {
		t.Fatal("no answer from the inbox")
	}
	if read := mcp("tools/call", map[string]any{"name": "farm_read", "arguments": map[string]any{}}).text(); !strings.Contains(read, "从 MCP 说一句") {
		t.Fatalf("read %q", read)
	}

	if text := foremanMcpClient(t, url, "")("tools/call", map[string]any{"name": "farm_who", "arguments": map[string]any{}}).text(); !strings.Contains(text, "没认出你是谁") {
		t.Fatalf("no token: %q", text)
	}
	if text := foremanMcpClient(t, url, "hb_w1_forged")("tools/call", map[string]any{"name": "farm_say", "arguments": map[string]any{"text": "冒名"}}).text(); !strings.Contains(text, "没认出你是谁") {
		t.Fatalf("forged: %q", text)
	}
}
