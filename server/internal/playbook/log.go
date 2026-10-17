package playbook

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"slices"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

const planReadLimit = 1000

type planPayload struct {
	Worker  *string                    `json:"worker,omitzero"`
	Detail  *string                    `json:"detail,omitzero"`
	Changes []protocol.NodeFieldChange `json:"changes,omitzero"`
	Commits []string                   `json:"commits,omitzero"`
}

type playbookLog struct{ q *generated.Queries }

func newPlaybookLog(db *sql.DB) (*playbookLog, error) { return &playbookLog{q: generated.New(db)}, nil }
func (*playbookLog) OnStart(context.Context) error    { return nil }
func (*playbookLog) OnStop()                          {}

// The history must never stop the playbook itself: what cannot be written is logged.
func (l *playbookLog) Record(before *protocol.Playbook, after protocol.Playbook, actor protocol.PlaybookActor, why string) {
	at := clock.NowMs()
	for _, c := range protocol.PlaybookChanges(before, after) {
		p := planPayload{Worker: c.Worker, Detail: c.Detail, Changes: c.Changes, Commits: c.Commits}
		if why != "" && (p.Detail == nil || *p.Detail == "") {
			w := why
			p.Detail = &w
		}
		payload, _ := json.Marshal(p)
		var node sql.NullString
		if c.Node != nil {
			node = sql.NullString{String: *c.Node, Valid: true}
		}
		if err := l.q.AddPlaybookEvent(context.Background(), generated.AddPlaybookEventParams{
			PlaybookID: c.Playbook, NodeID: node, Kind: string(c.Kind), Actor: string(actor), Payload: string(payload), CreatedAt: at,
		}); err != nil {
			log.Printf("vibevalley: a playbook event was not kept: %v", err)
		}
	}
}

// A row this code no longer knows how to read is left out.
func (l *playbookLog) List(playbook string) []protocol.PlaybookEvent {
	rows, err := l.q.PlaybookEvents(context.Background(), generated.PlaybookEventsParams{PlaybookID: playbook, Limit: planReadLimit})
	if err != nil {
		log.Printf("vibevalley: could not read playbook %s's history: %v", playbook, err)
		return []protocol.PlaybookEvent{}
	}
	out := []protocol.PlaybookEvent{}
	for _, row := range rows {
		e := protocol.PlaybookEvent{Seq: row.Seq, Playbook: row.PlaybookID, At: row.CreatedAt}
		node, payload := row.NodeID, row.Payload
		e.Kind, e.Actor = protocol.PlaybookEventKind(row.Kind), protocol.PlaybookActor(row.Actor)
		if !slices.Contains(protocol.PlaybookEventKindValues, e.Kind) || !slices.Contains(protocol.PlaybookActorValues, e.Actor) {
			continue
		}
		if node.Valid && node.String != "" {
			n := node.String
			e.Node = &n
		}
		var p planPayload
		if json.Unmarshal([]byte(payload), &p) == nil {
			e.Worker, e.Detail, e.Changes, e.Commits = p.Worker, p.Detail, p.Changes, p.Commits
		}
		out = append(out, e)
	}
	return out
}
