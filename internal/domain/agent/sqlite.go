package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

var agentSchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS agent_profile (
		id TEXT PRIMARY KEY,
		state_json TEXT NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS agent_skill (
		id TEXT PRIMARY KEY,
		built_in INTEGER NOT NULL DEFAULT 0,
		state_json TEXT NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS agent_runtime (
		id TEXT PRIMARY KEY,
		state_json TEXT NOT NULL
	)`,
}

type sqliteAgentBackend struct {
	mu     sync.Mutex
	db     *sql.DB
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
	for _, ddl := range agentSchemaDDL {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("agent: apply schema: %w", err)
		}
	}
	return &sqliteAgentBackend{db: db, ownsDB: true}, nil
}

func (b *sqliteAgentBackend) loadAll(ctx context.Context) ([]Profile, []Skill, []RuntimeInfo, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	var profiles []Profile
	pRows, err := b.db.QueryContext(ctx, `SELECT state_json FROM agent_profile`)
	if err != nil {
		return nil, nil, nil, err
	}
	for pRows.Next() {
		var raw string
		if err := pRows.Scan(&raw); err != nil {
			_ = pRows.Close()
			return nil, nil, nil, err
		}
		var p Profile
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			_ = pRows.Close()
			return nil, nil, nil, err
		}
		profiles = append(profiles, p)
	}
	_ = pRows.Close()

	var skills []Skill
	sRows, err := b.db.QueryContext(ctx, `SELECT state_json FROM agent_skill`)
	if err != nil {
		return nil, nil, nil, err
	}
	for sRows.Next() {
		var raw string
		if err := sRows.Scan(&raw); err != nil {
			_ = sRows.Close()
			return nil, nil, nil, err
		}
		var sk Skill
		if err := json.Unmarshal([]byte(raw), &sk); err != nil {
			_ = sRows.Close()
			return nil, nil, nil, err
		}
		skills = append(skills, sk)
	}
	_ = sRows.Close()

	var runtimes []RuntimeInfo
	rRows, err := b.db.QueryContext(ctx, `SELECT state_json FROM agent_runtime`)
	if err != nil {
		return nil, nil, nil, err
	}
	for rRows.Next() {
		var raw string
		if err := rRows.Scan(&raw); err != nil {
			_ = rRows.Close()
			return nil, nil, nil, err
		}
		var rt RuntimeInfo
		if err := json.Unmarshal([]byte(raw), &rt); err != nil {
			_ = rRows.Close()
			return nil, nil, nil, err
		}
		runtimes = append(runtimes, rt)
	}
	_ = rRows.Close()

	return profiles, skills, runtimes, nil
}

func (b *sqliteAgentBackend) saveProfile(ctx context.Context, p Profile) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO agent_profile (id, state_json, updated_at_ms) VALUES (?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`,
		p.ID, string(raw), p.UpdatedAtMs,
	)
	return err
}

func (b *sqliteAgentBackend) deleteProfile(ctx context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, err := b.db.ExecContext(ctx, `DELETE FROM agent_profile WHERE id = ?`, id)
	return err
}

func (b *sqliteAgentBackend) saveSkill(ctx context.Context, s Skill) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	bi := 0
	if s.BuiltIn {
		bi = 1
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO agent_skill (id, built_in, state_json, updated_at_ms) VALUES (?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET built_in = excluded.built_in, state_json = excluded.state_json, updated_at_ms = excluded.updated_at_ms`,
		s.ID, bi, string(raw), s.UpdatedAtMs,
	)
	return err
}

func (b *sqliteAgentBackend) deleteSkill(ctx context.Context, id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, err := b.db.ExecContext(ctx, `DELETE FROM agent_skill WHERE id = ?`, id)
	return err
}

func (b *sqliteAgentBackend) saveRuntime(ctx context.Context, r RuntimeInfo) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `INSERT INTO agent_runtime (id, state_json) VALUES (?, ?)
		ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json`,
		r.ID, string(raw),
	)
	return err
}

func (b *sqliteAgentBackend) close() error {
	if b.ownsDB && b.db != nil {
		return b.db.Close()
	}
	return nil
}
