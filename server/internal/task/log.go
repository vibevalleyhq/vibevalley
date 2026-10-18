package task

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"slices"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

const taskReadLimit = 1000

type taskPayload struct {
	Session *string                    `json:"session,omitzero"`
	Detail  *string                    `json:"detail,omitzero"`
	Changes []protocol.TaskFieldChange `json:"changes,omitzero"`
	Commits []string                   `json:"commits,omitzero"`
}

type taskLog struct{ q *generated.Queries }

func newTaskLog(db *sql.DB) (*taskLog, error)  { return &taskLog{q: generated.New(db)}, nil }
func (*taskLog) OnStart(context.Context) error { return nil }
func (*taskLog) OnStop()                       {}

// The history must never stop the task itself: what cannot be written is logged.
func (l *taskLog) Record(before *protocol.TaskGraph, after protocol.TaskGraph, actor protocol.GraphActor, why string) {
	at := clock.NowMs()
	for _, c := range protocol.GraphChanges(before, after) {
		p := taskPayload{Session: c.Session, Detail: c.Detail, Changes: c.Changes, Commits: c.Commits}
		if why != "" && (p.Detail == nil || *p.Detail == "") {
			w := why
			p.Detail = &w
		}
		payload, _ := json.Marshal(p)
		var task sql.NullString
		if c.Task != nil {
			task = sql.NullString{String: *c.Task, Valid: true}
		}
		if err := l.q.AddGraphEvent(context.Background(), generated.AddGraphEventParams{
			ID: base.NewID(), GraphID: c.Graph, TaskID: task, Kind: string(c.Kind), Actor: string(actor), Payload: string(payload), CreatedAt: at,
		}); err != nil {
			log.Printf("vibevalley: a task graph event was not kept: %v", err)
		}
	}
}

// A row this code no longer knows how to read is left out.
func (l *taskLog) List(graph string) []protocol.GraphEvent {
	rows, err := l.q.GraphEvents(context.Background(), generated.GraphEventsParams{GraphID: graph, Limit: taskReadLimit})
	if err != nil {
		log.Printf("vibevalley: could not read task graph %s's history: %v", graph, err)
		return []protocol.GraphEvent{}
	}
	out := []protocol.GraphEvent{}
	for _, row := range rows {
		e := protocol.GraphEvent{ID: row.ID, Graph: row.GraphID, At: row.CreatedAt}
		task, payload := row.TaskID, row.Payload
		e.Kind, e.Actor = protocol.GraphEventKind(row.Kind), protocol.GraphActor(row.Actor)
		if !slices.Contains(protocol.GraphEventKindValues, e.Kind) || !slices.Contains(protocol.GraphActorValues, e.Actor) {
			continue
		}
		if task.Valid && task.String != "" {
			id := task.String
			e.Task = &id
		}
		var p taskPayload
		if json.Unmarshal([]byte(payload), &p) == nil {
			e.Session, e.Detail, e.Changes, e.Commits = p.Session, p.Detail, p.Changes, p.Commits
		}
		out = append(out, e)
	}
	return out
}
