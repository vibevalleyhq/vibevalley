package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Nowledge Mem (https://mem.nowledge.co), a knowledge graph on this Mac, spoken to over MCP: memory_search reads, memory_add
// writes. Its other tools (threads, the library, deleting) are not used: it is the owner's own knowledge, and the farm only
// adds to it. What the farm writes carries labels, vibevalley and the profile's, so that a profile reads back its own; with
// Everything it reads all that is in it.
type nowledge struct {
	c setting.MemorySourceConfig

	mu      sync.Mutex
	session *sdk.ClientSession
}

const (
	nowledgeName = string(protocol.MemorySourceKindNowledge)
	// The app its writes and searches say they come from (source_app).
	nowledgeApp = "vibevalley"
	// Its memory_search takes at most 20, and a query of at most 500 characters.
	nowledgeMost  = 20
	nowledgeQuery = 500
	// What a recalled line carries of one of its memories, in UTF-16 units.
	nowledgeLine = 200
)

func newNowledge(c setting.MemorySourceConfig) *nowledge { return &nowledge{c: c} }

func (*nowledge) Name() string { return nowledgeName }

func (n *nowledge) Available() (bool, string) {
	if n.c.URL == "" {
		return false, "没填地址"
	}
	return true, ""
}

// The session opens on first use, not here: Nowledge not running when the farm starts must not keep it off until a restart.
func (*nowledge) OnStart(context.Context) error { return nil }

func (n *nowledge) OnStop() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.session != nil {
		n.session.Close()
		n.session = nil
	}
}

func (*nowledge) Can() abilities { return abilities{List: true} }

type nowledgeKey struct {
	key  string
	next http.RoundTripper
}

func (k nowledgeKey) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+k.key)
	return k.next.RoundTrip(r)
}

// Not connected under n.mu: a Nowledge that does not answer would hold OnStop up.
func (n *nowledge) open(ctx context.Context) (*sdk.ClientSession, error) {
	n.mu.Lock()
	session := n.session
	n.mu.Unlock()
	if session != nil {
		return session, nil
	}
	client := &http.Client{Timeout: writeTimeout}
	if n.c.Key != "" {
		client.Transport = nowledgeKey{n.c.Key, http.DefaultTransport}
	}
	transport := &sdk.StreamableClientTransport{Endpoint: n.c.URL, HTTPClient: client, MaxRetries: -1, DisableStandaloneSSE: true}
	session, err := sdk.NewClient(&sdk.Implementation{Name: nowledgeApp, Version: "1"}, nil).Connect(ctx, transport, nil)
	if err != nil {
		return nil, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.session != nil {
		session.Close()
		return n.session, nil
	}
	n.session = session
	return session, nil
}

type nowledgeAnswer struct {
	text string
	err  error
}

// One tool call; its answer is the text of the result. The SDK's requests do not end with ctx (it detaches the connection's
// context), so the caller stops waiting at ctx's end and the request itself ends at the client's timeout.
func (n *nowledge) call(ctx context.Context, tool string, args map[string]any) (string, error) {
	answer := make(chan nowledgeAnswer, 1)
	go func() {
		text, err := n.callNow(ctx, tool, args)
		answer <- nowledgeAnswer{text, err}
	}()
	select {
	case a := <-answer:
		return a.text, a.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// A session that failed is dropped, so the next call opens a new one (Nowledge restarted, the session expired).
func (n *nowledge) callNow(ctx context.Context, tool string, args map[string]any) (string, error) {
	session, err := n.open(ctx)
	if err != nil {
		return "", err
	}
	res, err := session.CallTool(ctx, &sdk.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		n.mu.Lock()
		if n.session == session {
			session.Close()
			n.session = nil
		}
		n.mu.Unlock()
		return "", err
	}
	var text strings.Builder
	for _, c := range res.Content {
		if t, ok := c.(*sdk.TextContent); ok {
			text.WriteString(t.Text)
		}
	}
	if res.IsError {
		return "", errors.New(tool + ": " + str.Head(text.String(), 300))
	}
	return text.String(), nil
}

// Its labels are words without spaces or commas (the list is comma-separated).
var nowledgeLabelUnsafe = regexp.MustCompile(`[\s,]+`)

func nowledgeLabel(kind, name string) string {
	return nowledgeApp + "-" + kind + "-" + nowledgeLabelUnsafe.ReplaceAllString(name, "-")
}

// What the farm writes for agent, in project ("" every project).
func nowledgeLabels(agent, project string) string {
	labels := []string{nowledgeApp, nowledgeLabel("agent", agent)}
	if project != "" {
		labels = append(labels, nowledgeLabel("project", project))
	}
	return strings.Join(labels, ",")
}

type nowledgeHit struct {
	ID        string  `json:"id"`
	MemoryID  string  `json:"memory_id"`
	Title     string  `json:"title"`
	Content   string  `json:"content"`
	Preview   string  `json:"content_preview"`
	Relevance float64 `json:"relevance_score"`
}

func (h nowledgeHit) id() string {
	if h.MemoryID != "" {
		return h.MemoryID
	}
	return h.ID
}

func (h nowledgeHit) text() string {
	body := h.Preview
	if body == "" {
		body = h.Content
	}
	if h.Title == "" || strings.HasPrefix(body, h.Title) {
		return body
	}
	return h.Title + "：" + body
}

// agent "" reads what the farm wrote for any profile; everything reads all that is in it. Whatever is sent is redacted: a
// run's words may carry a key.
func (n *nowledge) search(ctx context.Context, agent, query string, limit int, everything bool) ([]nowledgeHit, error) {
	args := map[string]any{"limit": max(1, min(limit, nowledgeMost)), "source_app": nowledgeApp}
	if q := str.Head(strings.TrimSpace(base.Redact(query)), nowledgeQuery); q != "" {
		args["query"] = q
	}
	if !everything {
		args["filter_labels"] = nowledgeApp
		if agent != "" {
			args["filter_labels"] = nowledgeLabel("agent", agent)
		}
	}
	text, err := n.call(ctx, "memory_search", args)
	if err != nil {
		return nil, err
	}
	var found struct {
		Results []nowledgeHit `json:"results"`
	}
	if err := json.Unmarshal([]byte(text), &found); err != nil {
		return nil, errors.New("memory_search answered what it should not: " + str.Head(text, 200))
	}
	return found.Results, nil
}

// Nothing to ask with, nothing asked: listing its newest would only be noise at the start of a run.
func (n *nowledge) Prefetch(ctx context.Context, cue RecallCue) ([]recalledLine, error) {
	if !n.c.Read || strings.TrimSpace(cue.Text) == "" {
		return nil, nil
	}
	hits, err := n.search(ctx, cue.Agent, cue.Text, recallCount, n.c.Everything)
	if err != nil {
		return nil, err
	}
	var out []recalledLine
	for _, h := range hits {
		if cue.Skip[h.id()] {
			continue
		}
		out = append(out, recalledLine{ID: h.id(), Line: "- （Nowledge）" + str.Clip(h.text(), nowledgeLine), Score: h.Relevance})
	}
	return out, nil
}

// Its memories are notes; it has no jobs done (those are its threads, not read here).
func (n *nowledge) Search(ctx context.Context, q SearchQuery) ([]Found, error) {
	if !n.c.Read || q.Kind == protocol.MemoryKindIssue {
		return nil, nil
	}
	hits, err := n.search(ctx, q.Agent, q.Text, q.Limit, n.c.Everything)
	if err != nil {
		return nil, err
	}
	out := make([]Found, len(hits))
	for i, h := range hits {
		out[i] = Found{Memory: protocol.Memory{ID: h.id(), Agent: q.Agent, Kind: protocol.MemoryKindNote, Text: h.text()}, Score: h.Relevance}
	}
	return out, nil
}

// The farm's own, newest first; Nowledge does not say which project each is for.
func (n *nowledge) List(ctx context.Context, agent string) ([]protocol.Memory, error) {
	if !n.c.Read {
		return nil, nil
	}
	hits, err := n.search(ctx, agent, "", nowledgeMost, false)
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Memory, len(hits))
	for i, h := range hits {
		out[i] = protocol.Memory{ID: h.id(), Agent: agent, Kind: protocol.MemoryKindNote, Text: h.text()}
	}
	return out, nil
}

func (n *nowledge) add(ctx context.Context, agent, text, project string) (string, error) {
	body := base.Redact(text)
	answer, err := n.call(ctx, "memory_add", map[string]any{
		"content":    body,
		"title":      str.Head(body, 60),
		"labels":     nowledgeLabels(agent, project),
		"source_app": nowledgeApp,
	})
	if err != nil {
		return "", err
	}
	// The new memory's id, at the top or under memory; none when it found the same memory there already (candidates_found).
	var added struct {
		ID       string `json:"id"`
		MemoryID string `json:"memory_id"`
		Memory   struct {
			ID string `json:"id"`
		} `json:"memory"`
	}
	_ = json.Unmarshal([]byte(answer), &added)
	for _, id := range []string{added.MemoryID, added.ID, added.Memory.ID} {
		if id != "" {
			return id, nil
		}
	}
	return "", nil
}

// The 「记住：」 lines, as the local provider reads them; a stopped run leaves nothing here either.
func (n *nowledge) SyncTurn(ctx context.Context, run FinishedRun) error {
	if !n.c.Write || run.Outcome == protocol.OutcomeInterrupted {
		return nil
	}
	for _, note := range memoryNotesOf(run.Said) {
		project := run.Project
		if note.Everywhere {
			project = ""
		}
		if _, err := n.add(ctx, run.Agent, note.Text, project); err != nil {
			return err
		}
	}
	return nil
}

func (*nowledge) OnSessionEnd(context.Context, EndedSession) error { return nil }

func (n *nowledge) Add(ctx context.Context, note Note) (protocol.Memory, error) {
	if !n.c.Write {
		return protocol.Memory{}, nil
	}
	project := strings.TrimSpace(note.Project)
	id, err := n.add(ctx, note.Agent, note.Text, project)
	if err != nil {
		return protocol.Memory{}, err
	}
	m := protocol.Memory{ID: id, Agent: note.Agent, Kind: protocol.MemoryKindNote, Text: note.Text, At: clock.NowMs()}
	if project != "" {
		m.Project = &project
	}
	return m, nil
}

func (*nowledge) Forget(context.Context, string, string) error {
	return protocol.Refused{Reason: "Nowledge Mem 里的记忆到 Nowledge Mem 里删"}
}
