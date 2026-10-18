package engine

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// Where one owner's open graph lives. Change applies f to the open graph and keeps what it returns, all at once; a
// finished graph is put away and the owner's open graph is empty again. It answers the graph as kept, before putting
// it away, so the caller can still say how it ended.
type Store interface {
	Load(ctx context.Context) ([]Task, error)
	Change(ctx context.Context, f func([]Task) ([]Task, error)) ([]Task, error)
}

// The farm's database (task_graph): an owner is whoever keeps the graph, a session id or the manager. A finished graph
// stays, stamped finished_at.
type DBStore struct {
	db    *sql.DB
	owner string
}

func NewDBStore(db *sql.DB, owner string) *DBStore { return &DBStore{db: db, owner: owner} }

func fromRow(r generated.TaskGraph) Task {
	t := Task{ID: r.ID, Title: r.Title, Brief: r.Brief, By: By(r.Executor), State: State(r.State), Result: r.Result, Tries: int(r.Tries)}
	if err := json.Unmarshal([]byte(r.After), &t.After); err != nil || t.After == nil {
		t.After = []string{}
	}
	return t
}

func (s *DBStore) Load(ctx context.Context) ([]Task, error) {
	rows, err := generated.New(s.db).OpenGraphTasks(ctx, s.owner)
	if err != nil {
		return nil, err
	}
	g := make([]Task, len(rows))
	for i, r := range rows {
		g[i] = fromRow(r)
	}
	return g, nil
}

func (s *DBStore) Change(ctx context.Context, f func([]Task) ([]Task, error)) ([]Task, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	q := generated.New(tx)
	rows, err := q.OpenGraphTasks(ctx, s.owner)
	if err != nil {
		return nil, err
	}
	before := make([]Task, len(rows))
	for i, r := range rows {
		before[i] = fromRow(r)
	}
	g, err := f(before)
	if err != nil {
		return nil, err
	}
	// The graph keeps its id while it is open; a new one starts when the owner had none.
	graph := base.NewID()
	if len(rows) > 0 {
		graph = rows[0].Graph
	}
	if err := q.ClearOpenGraphTasks(ctx, s.owner); err != nil {
		return nil, err
	}
	now := clock.NowMs()
	for i, t := range g {
		after, _ := json.Marshal(t.After)
		if err := q.AddGraphTask(ctx, generated.AddGraphTaskParams{
			Graph: graph, Owner: s.owner, ID: t.ID, Position: int64(i), Title: t.Title, Brief: t.Brief, After: string(after),
			Executor: string(t.By), State: string(t.State), Result: t.Result, Tries: int64(t.Tries), UpdatedAt: now,
		}); err != nil {
			return nil, err
		}
	}
	if Finished(g) {
		if err := q.FinishGraphTasks(ctx, generated.FinishGraphTasksParams{FinishedAt: sql.NullInt64{Int64: now, Valid: true}, Owner: s.owner}); err != nil {
			return nil, err
		}
	}
	return g, tx.Commit()
}

// For an agent with no farm behind it (the command line): the graph lasts as long as the process.
type MemoryStore struct {
	mu sync.Mutex
	g  []Task
}

func (s *MemoryStore) Load(context.Context) ([]Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Task{}, s.g...), nil
}

func (s *MemoryStore) Change(_ context.Context, f func([]Task) ([]Task, error)) ([]Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, err := f(append([]Task{}, s.g...))
	if err != nil {
		return nil, err
	}
	s.g = g
	if Finished(g) {
		s.g = nil
	}
	return g, nil
}
