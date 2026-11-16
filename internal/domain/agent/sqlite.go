package agent

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent/sqlcgen"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

// MigrationsFS embeds the SQLite migration scripts for the agent registry.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS

type sqliteAgentBackend struct {
	mu     sync.Mutex
	db     *sql.DB
	q      *sqlcgen.Queries
	ownsDB bool
}

func openSQLiteAgentBackend(ctx context.Context, path string) (*sqliteAgentBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory") || strings.Contains(path, ":memory:")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("agent: mkdir %s: %w", dir, err)
			}
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("agent: open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	pragmas := []string{
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
		"PRAGMA synchronous=NORMAL",
	}
	if !isMem {
		pragmas = append([]string{"PRAGMA journal_mode=WAL"}, pragmas...)
	}
	for _, p := range pragmas {
		if _, err := db.ExecContext(ctx, p); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("agent: %s: %w", p, err)
		}
	}

	runner, err := migrate.New(db, "agent", MigrationsFS)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("agent: init migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("agent: apply migrations: %w", err)
	}

	return &sqliteAgentBackend{
		db:     db,
		q:      sqlcgen.New(db),
		ownsDB: true,
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
	return b.q.SaveProfile(ctx, sqlcgen.SaveProfileParams{
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
	return b.q.SaveSkill(ctx, sqlcgen.SaveSkillParams{
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
	return b.q.SaveRuntime(ctx, sqlcgen.SaveRuntimeParams{
		ID:        r.ID,
		StateJson: string(raw),
	})
}

func (b *sqliteAgentBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}
