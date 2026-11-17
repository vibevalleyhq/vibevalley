package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

type sqliteAgentBackend struct {
	mu     sync.Mutex
	pool   *db.Pool
	db     *sql.DB
	q      *dbgen.Queries
	ownsDB bool
}

func openSQLiteAgentBackend(ctx context.Context, path string) (*sqliteAgentBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pool, err := db.OpenPool(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("agent: open sqlite: %w", err)
	}

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("agent: init migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("agent: apply migrations: %w", err)
	}

	return &sqliteAgentBackend{
		pool:   pool,
		db:     pool.WriteDB,
		q:      dbgen.New(pool.WriteDB),
		ownsDB: true,
	}, nil
}

func openSQLiteAgentFromDB(sqlDB *sql.DB) (*sqliteAgentBackend, error) {
	if sqlDB == nil {
		return nil, fmt.Errorf("%w: sql.DB is required", ErrInvalidArgument)
	}
	return &sqliteAgentBackend{
		db:     sqlDB,
		q:      dbgen.New(sqlDB),
		ownsDB: false,
	}, nil
}

func decodeJSONStates[T any](rawStates []string) ([]T, error) {
	out := make([]T, 0, len(rawStates))
	for _, raw := range rawStates {
		var item T
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func (b *sqliteAgentBackend) loadAll(ctx context.Context) ([]Profile, []Skill, []RuntimeInfo, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	rawProfiles, err := b.q.ListProfiles(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	profiles, err := decodeJSONStates[Profile](rawProfiles)
	if err != nil {
		return nil, nil, nil, err
	}

	rawSkills, err := b.q.ListSkills(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	skills, err := decodeJSONStates[Skill](rawSkills)
	if err != nil {
		return nil, nil, nil, err
	}

	rawRuntimes, err := b.q.ListRuntimes(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	runtimes, err := decodeJSONStates[RuntimeInfo](rawRuntimes)
	if err != nil {
		return nil, nil, nil, err
	}

	return profiles, skills, runtimes, nil
}

func (b *sqliteAgentBackend) saveProfile(ctx context.Context, p Profile) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return b.q.SaveProfile(ctx, dbgen.SaveProfileParams{
		ID:          p.ID,
		StateJson:   string(raw),
		UpdatedAtMs: p.UpdatedAtMs,
	})
}

func (b *sqliteAgentBackend) deleteProfile(ctx context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.q.DeleteProfile(ctx, id)
}

func (b *sqliteAgentBackend) saveSkill(ctx context.Context, s Skill) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	var bi int64
	if s.BuiltIn {
		bi = 1
	}
	return b.q.SaveSkill(ctx, dbgen.SaveSkillParams{
		ID:          s.ID,
		BuiltIn:     bi,
		StateJson:   string(raw),
		UpdatedAtMs: s.UpdatedAtMs,
	})
}

func (b *sqliteAgentBackend) deleteSkill(ctx context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.q.DeleteSkill(ctx, id)
}

func (b *sqliteAgentBackend) saveRuntime(ctx context.Context, r RuntimeInfo) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return b.q.SaveRuntime(ctx, dbgen.SaveRuntimeParams{
		ID:        r.ID,
		StateJson: string(raw),
	})
}

func (b *sqliteAgentBackend) close() error {
	if !b.ownsDB {
		return nil
	}
	if b.pool != nil {
		return b.pool.Close()
	}
	if b.db != nil {
		return b.db.Close()
	}
	return nil
}
