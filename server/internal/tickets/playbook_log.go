package tickets

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"slices"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// A playbook's history (ported from the TypeScript server's playbook-log.ts, removed). Every write of a playbook is compared with the version
// before it (protocol.PlaybookChanges), and what changed is kept in playbook_events with who did it: the person, the
// manager, or the farm itself. The plan board reads it to show how a step got where it is.
// Rationale: .agents/notes/implemented/feature/2026-10-11-playbooks.md「对照 Raft 的任务」.

// planReadLimit is the most events read back for one playbook.
const planReadLimit = 1000

// planPayload is what an event carries beside its kind, as stored.
type planPayload struct {
	Helper  *string                    `json:"helper,omitzero"`
	Detail  *string                    `json:"detail,omitzero"`
	Changes []protocol.NodeFieldChange `json:"changes,omitzero"`
	Commits []string                   `json:"commits,omitzero"`
}

type PlaybookLog struct{ db *sql.DB }

func newPlaybookLog(db *sql.DB) (*PlaybookLog, error) { return &PlaybookLog{db: db}, nil }
func (*PlaybookLog) OnStart(context.Context) error    { return nil }
func (*PlaybookLog) OnStop()                          {}

// Record keeps what changed from before to after, done by actor; why explains a change that does not say itself.
// The history must never stop the playbook itself: what cannot be written is logged.
func (l *PlaybookLog) Record(before *protocol.Playbook, after protocol.Playbook, actor protocol.PlaybookActor, why string) {
	at := base.NowMs()
	for _, c := range protocol.PlaybookChanges(before, after) {
		p := planPayload{Helper: c.Helper, Detail: c.Detail, Changes: c.Changes, Commits: c.Commits}
		if why != "" && (p.Detail == nil || *p.Detail == "") {
			w := why
			p.Detail = &w
		}
		payload, _ := json.Marshal(p)
		var node any
		if c.Node != nil {
			node = *c.Node
		}
		if _, err := l.db.Exec(
			"insert into playbook_events (playbook_id, node_id, kind, actor, payload, created_at) values (?, ?, ?, ?, ?, ?)",
			c.Playbook, node, string(c.Kind), string(actor), string(payload), at,
		); err != nil {
			log.Printf("vibevalley: a playbook event was not kept: %v", err)
		}
	}
}

// List is a playbook's history, oldest first; a row this code no longer knows how to read is left out.
func (l *PlaybookLog) List(playbook string) []protocol.PlaybookEvent {
	rows, err := l.db.Query(
		"select seq, playbook_id, node_id, kind, actor, payload, created_at from playbook_events where playbook_id = ? order by seq limit ?",
		playbook, planReadLimit,
	)
	if err != nil {
		log.Printf("vibevalley: could not read playbook %s's history: %v", playbook, err)
		return []protocol.PlaybookEvent{}
	}
	defer rows.Close()
	out := []protocol.PlaybookEvent{}
	for rows.Next() {
		var e protocol.PlaybookEvent
		var node sql.NullString
		var kind, actor, payload string
		if err := rows.Scan(&e.Seq, &e.Playbook, &node, &kind, &actor, &payload, &e.At); err != nil {
			log.Printf("vibevalley: a playbook event unreadable: %v", err)
			continue
		}
		e.Kind, e.Actor = protocol.PlaybookEventKind(kind), protocol.PlaybookActor(actor)
		if !slices.Contains(protocol.PlaybookEventKindValues, e.Kind) || !slices.Contains(protocol.PlaybookActorValues, e.Actor) {
			continue
		}
		if node.Valid && node.String != "" {
			n := node.String
			e.Node = &n
		}
		var p planPayload
		if json.Unmarshal([]byte(payload), &p) == nil {
			e.Helper, e.Detail, e.Changes, e.Commits = p.Helper, p.Detail, p.Changes, p.Commits
		}
		out = append(out, e)
	}
	return out
}
