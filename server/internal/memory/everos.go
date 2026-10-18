package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// EverOS (github.com/EverMind-AI/EverOS) over its HTTP API, /api/v2. It is given whole runs and extracts memories itself
// with a model: memory/add takes a session's messages, memory/flush makes it extract them (here when the session leaves the
// farm), memory/search reads back. It owns a memory by its sender: what a helper says is the agent's (agent_id, read back as
// agent_cases), what it was asked is the owner's (user_id, read back as episodes). The wire shapes are those Raven's
// everos-memory plugin speaks (raven_everos/backend.py, EverOS 1.2).
type everos struct {
	c    setting.MemorySourceConfig
	http *http.Client

	mu sync.Mutex
	// Its sessions (everosSession) given messages and not yet told to extract; flushed when the session ends, or when the farm stops.
	pending map[string]everosScope
	// Sessions whose job it was given already: a later run sends only what the helper said.
	told map[string]bool
}

type everosScope struct {
	project string
}

const (
	everosName = string(protocol.MemorySourceKindEveros)
	// app_id on everything written, so its memories can be told from another app's.
	everosApp = "vibevalley"
	// Its search takes top_k 1..100.
	everosMost = 100
	// What a recalled line carries of one of its memories, in UTF-16 units.
	everosLine = 200
)

func newEveros(c setting.MemorySourceConfig) *everos {
	return &everos{c: c, http: &http.Client{Timeout: writeTimeout}, pending: map[string]everosScope{}, told: map[string]bool{}}
}

func (*everos) Name() string { return everosName }

func (e *everos) Available() (bool, string) {
	if e.c.URL == "" {
		return false, "没填地址"
	}
	return true, ""
}

func (*everos) OnStart(context.Context) error { return nil }

// What it was given and not told to extract yet is extracted now: a session left on the farm comes back after a restart as
// a new run, and EverOS only extracts on a flush.
func (e *everos) OnStop() {
	e.mu.Lock()
	pending := e.pending
	e.pending = map[string]everosScope{}
	e.mu.Unlock()
	for session, scope := range pending {
		ctx, cancel := context.WithTimeout(context.Background(), prefetchTimeout)
		if err := e.flush(ctx, session, scope.project); err != nil {
			log.Printf("vibevalley: everos did not extract %s before the farm stopped: %v", session, err)
		}
		cancel()
	}
}

func (*everos) Can() abilities { return abilities{Transcripts: true} }

// The owner's user_id, and a profile's agent_id: prefixed, since other apps keep their own agents in the same EverOS.
func (e *everos) user() string {
	if e.c.User != "" {
		return e.c.User
	}
	return "owner"
}

func everosAgent(agent string) string { return everosApp + "-" + agent }

// A farm's session ids (w1, w2…) are its own only: another farm on the same EverOS has a w1 too.
func everosSession(session string) string { return everosApp + "-" + session }

func (e *everos) post(ctx context.Context, path string, body any, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(e.c.URL, "/")+"/api/v2/memory/"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if e.c.Key != "" {
		req.Header.Set("Authorization", "Bearer "+e.c.Key)
	}
	res, err := e.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("memory/%s: %s %s", path, res.Status, str.Head(string(answer), 300))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(answer, out); err != nil {
		return fmt.Errorf("memory/%s answered what it should not: %s", path, str.Head(string(answer), 200))
	}
	return nil
}

type everosMessage struct {
	SenderID  string `json:"sender_id"`
	Role      string `json:"role"`
	Timestamp int64  `json:"timestamp"`
	Content   string `json:"content"`
}

// Every message's text is redacted first: a helper's words may carry a key.
func (e *everos) add(ctx context.Context, session, project string, messages []everosMessage) error {
	for i := range messages {
		messages[i].Content = base.Redact(messages[i].Content)
	}
	body := map[string]any{"session_id": session, "messages": messages, "app_id": everosApp}
	if project != "" {
		body["project_id"] = project
	}
	if err := e.post(ctx, "add", body, nil); err != nil {
		return err
	}
	e.mu.Lock()
	e.pending[session] = everosScope{project}
	e.mu.Unlock()
	return nil
}

func (e *everos) flush(ctx context.Context, session, project string) error {
	body := map[string]any{"session_id": session, "app_id": everosApp}
	if project != "" {
		body["project_id"] = project
	}
	return e.post(ctx, "flush", body, nil)
}

// The job once per session (the owner's words), then what the helper said in this run; a failed run says so, since EverOS
// learns from what did not work too. A stopped run leaves nothing, as everywhere.
func (e *everos) SyncTurn(ctx context.Context, run FinishedRun) error {
	if !e.c.Write || run.Outcome == protocol.OutcomeInterrupted {
		return nil
	}
	now := clock.NowMs()
	var messages []everosMessage
	e.mu.Lock()
	first := !e.told[run.Session]
	e.mu.Unlock()
	if first && strings.TrimSpace(run.Job) != "" {
		messages = append(messages, everosMessage{SenderID: e.user(), Role: "user", Timestamp: now, Content: run.Job})
	}
	said := run.Said
	if strings.TrimSpace(said) == "" {
		said = run.Summary
	}
	if run.Outcome == protocol.OutcomeFailed {
		said = "（这一轮没做成）" + said
	}
	if strings.TrimSpace(said) != "" {
		messages = append(messages, everosMessage{SenderID: everosAgent(run.Agent), Role: "assistant", Timestamp: now, Content: said})
	}
	if len(messages) == 0 {
		return nil
	}
	if err := e.add(ctx, everosSession(run.Session), run.Project, messages); err != nil {
		return err
	}
	e.mu.Lock()
	e.told[run.Session] = true
	e.mu.Unlock()
	return nil
}

func (e *everos) OnSessionEnd(ctx context.Context, s EndedSession) error {
	session := everosSession(s.Session)
	e.mu.Lock()
	scope, given := e.pending[session]
	delete(e.pending, session)
	delete(e.told, s.Session)
	e.mu.Unlock()
	if !given {
		return nil
	}
	return e.flush(ctx, session, scope.project)
}

// A note written outside a run is a conversation of its own: the owner asks the profile to remember, and it is extracted
// at once.
func (e *everos) Add(ctx context.Context, n Note) (protocol.Memory, error) {
	if !e.c.Write {
		return protocol.Memory{}, nil
	}
	session := "vibevalley-note-" + n.Agent + "-" + base.NewID()
	project := strings.TrimSpace(n.Project)
	where := "所有项目"
	if project != "" {
		where = "项目 " + project
	}
	now := clock.NowMs()
	messages := []everosMessage{
		{SenderID: e.user(), Role: "user", Timestamp: now, Content: "记住（" + where + "）：" + n.Text},
		{SenderID: everosAgent(n.Agent), Role: "assistant", Timestamp: now, Content: "记下了：" + n.Text},
	}
	if err := e.add(ctx, session, project, messages); err != nil {
		return protocol.Memory{}, err
	}
	err := e.flush(ctx, session, project)
	e.mu.Lock()
	delete(e.pending, session)
	e.mu.Unlock()
	return protocol.Memory{}, err
}

type everosFound struct {
	Data struct {
		Episodes []struct {
			ID      string  `json:"id"`
			Subject string  `json:"subject"`
			Summary string  `json:"summary"`
			Episode string  `json:"episode"`
			Score   float64 `json:"score"`
		} `json:"episodes"`
		AgentCases []struct {
			ID         string  `json:"id"`
			TaskIntent string  `json:"task_intent"`
			Approach   string  `json:"approach"`
			KeyInsight string  `json:"key_insight"`
			Score      float64 `json:"score"`
		} `json:"agent_cases"`
	} `json:"data"`
}

type everosHit struct {
	id, text string
	score    float64
}

// A profile's cases (how it did a kind of work), or with issue the owner's episodes (what happened). It takes one owner a
// search, user_id or agent_id; the skills it also keeps are not read here (skills go through the 技能书).
func (e *everos) search(ctx context.Context, agent, query string, limit int, kind protocol.MemoryKind) ([]everosHit, error) {
	body := map[string]any{"query": str.Head(strings.TrimSpace(base.Redact(query)), 1000), "top_k": max(1, min(limit, everosMost))}
	if kind == protocol.MemoryKindIssue {
		body["user_id"] = e.user()
	} else {
		body["agent_id"] = everosAgent(agent)
	}
	var found everosFound
	if err := e.post(ctx, "search", body, &found); err != nil {
		return nil, err
	}
	var hits []everosHit
	for _, c := range found.Data.AgentCases {
		var parts []string
		for _, p := range []string{c.TaskIntent, c.Approach, c.KeyInsight} {
			if p = strings.TrimSpace(p); p != "" {
				parts = append(parts, p)
			}
		}
		hits = append(hits, everosHit{c.ID, strings.Join(parts, "；"), c.Score})
	}
	for _, ep := range found.Data.Episodes {
		text := ep.Summary
		if text == "" {
			text = ep.Episode
		}
		if ep.Subject != "" {
			text = ep.Subject + "：" + text
		}
		hits = append(hits, everosHit{ep.ID, text, ep.Score})
	}
	return hits, nil
}

func (e *everos) Prefetch(ctx context.Context, cue RecallCue) ([]recalledLine, error) {
	if !e.c.Read || strings.TrimSpace(cue.Text) == "" {
		return nil, nil
	}
	hits, err := e.search(ctx, cue.Agent, cue.Text, recallCount, protocol.MemoryKindNote)
	if err != nil {
		return nil, err
	}
	var out []recalledLine
	for _, h := range hits {
		if cue.Skip[h.id] || h.text == "" {
			continue
		}
		out = append(out, recalledLine{ID: h.id, Line: "- （EverOS）" + str.Clip(h.text, everosLine), Score: h.score})
	}
	return out, nil
}

// A search over every profile has no one owner to ask with: it gives nothing here.
func (e *everos) Search(ctx context.Context, q SearchQuery) ([]Found, error) {
	if !e.c.Read || strings.TrimSpace(q.Text) == "" || (q.Agent == "" && q.Kind != protocol.MemoryKindIssue) {
		return nil, nil
	}
	kind := q.Kind
	if kind == "" {
		kind = protocol.MemoryKindNote
	}
	hits, err := e.search(ctx, q.Agent, q.Text, q.Limit, kind)
	if err != nil {
		return nil, err
	}
	var out []Found
	for _, h := range hits {
		if h.text != "" {
			out = append(out, Found{Memory: protocol.Memory{ID: h.id, Agent: q.Agent, Kind: kind, Text: h.text}, Score: h.score})
		}
	}
	return out, nil
}

func (*everos) List(context.Context, string) ([]protocol.Memory, error) {
	return nil, errors.New("EverOS 的记忆不在这里列出")
}

func (*everos) Forget(context.Context, string, string) error {
	return protocol.Refused{Reason: "EverOS 里的记忆到 EverOS 里删"}
}
