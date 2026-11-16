package stack

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/viant/sqlite-vec/engine"
	"github.com/viant/sqlite-vec/vec"
	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/game"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	domainwatch "github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

// ScopeMigrationResult summarizes migration progress or rollback for a single SQL module scope.
type ScopeMigrationResult struct {
	Scope         string `json:"scope"`
	DBPath        string `json:"dbPath"`
	BeforeVersion int64  `json:"beforeVersion"`
	AfterVersion  int64  `json:"afterVersion"`
	Applied       int    `json:"applied"`
	Reverted      int    `json:"reverted"`
	Pending       int    `json:"pending"`
}

type migrationScopeSpec struct {
	Scope     string
	FS        fs.FS
	EnableVec bool
}

var stackMigrationScopes = []migrationScopeSpec{
	{Scope: "durable", FS: store.MigrationsFS},
	{Scope: "vault", FS: vault.MigrationsFS},
	{Scope: "agent", FS: agent.MigrationsFS},
	{Scope: "repo", FS: repo.MigrationsFS},
	{Scope: "channel", FS: channel.MigrationsFS},
	{Scope: "issue", FS: issue.MigrationsFS},
	{Scope: "watch", FS: domainwatch.MigrationsFS},
	{Scope: "game", FS: game.MigrationsFS},
	{Scope: "memory", FS: memory.MigrationsFS},
	{Scope: "pkm", FS: pkm.MigrationsFS, EnableVec: true},
}

var registerMigrateVecFuncsOnce sync.Once

// MigrationScopes returns the ordered list of all SQL module migration scope names coordinated by stack.
func MigrationScopes() []string {
	out := make([]string, len(stackMigrationScopes))
	for i, spec := range stackMigrationScopes {
		out[i] = spec.Scope
	}
	return out
}

// ScopeDBPath resolves the SQLite WAL or memory DSN for scope relative to baseDBPath.
// The primary "durable" scope uses baseDBPath directly; all other scopes use sidecar WAL files
// unless baseDBPath is an in-memory DSN.
func ScopeDBPath(baseDBPath, scope string) string {
	trimmed := strings.TrimSpace(baseDBPath)
	if trimmed == "" {
		trimmed = ":memory:"
	}
	if isMemorySQLiteDSN(trimmed) || scope == "durable" {
		return trimmed
	}
	return sidecarDBPath(trimmed, scope)
}

func isMemorySQLiteDSN(dsn string) bool {
	return dsn == ":memory:" || strings.Contains(dsn, "mode=memory") || strings.Contains(dsn, ":memory:")
}

// MigrateUp applies all pending SQL migrations across all 10 platform module scopes.
func MigrateUp(ctx context.Context, dbPath string) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	normalized := normalizeBaseDBPath(dbPath)
	if isMemorySQLiteDSN(normalized) {
		db, err := openScopeMigrationDB(ctx, normalized, true, true)
		if err != nil {
			return nil, err
		}
		defer func() { _ = db.Close() }()
		return MigrateUpDB(ctx, db, normalized)
	}

	results := make([]ScopeMigrationResult, 0, len(stackMigrationScopes))
	for _, spec := range stackMigrationScopes {
		scopePath := ScopeDBPath(normalized, spec.Scope)
		res, err := withScopeDB(ctx, scopePath, false, spec.EnableVec, func(db *sql.DB) (ScopeMigrationResult, error) {
			return migrateScopeUp(ctx, db, spec.Scope, spec.FS, scopePath)
		})
		if err != nil {
			return results, err
		}
		results = append(results, res)
	}
	return results, nil
}

// MigrateDown reverts migrations across all 10 platform module scopes (either all applied versions or up to steps).
func MigrateDown(ctx context.Context, dbPath string, steps int, all bool) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if !all && steps < 0 {
		return nil, fmt.Errorf("stack: migrate down requires non-negative steps, got %d", steps)
	}
	normalized := normalizeBaseDBPath(dbPath)
	if isMemorySQLiteDSN(normalized) {
		db, err := openScopeMigrationDB(ctx, normalized, true, true)
		if err != nil {
			return nil, err
		}
		defer func() { _ = db.Close() }()
		return MigrateDownDB(ctx, db, normalized, steps, all)
	}

	results := make([]ScopeMigrationResult, 0, len(stackMigrationScopes))
	for _, spec := range stackMigrationScopes {
		scopePath := ScopeDBPath(normalized, spec.Scope)
		res, err := withScopeDB(ctx, scopePath, false, spec.EnableVec, func(db *sql.DB) (ScopeMigrationResult, error) {
			return migrateScopeDown(ctx, db, spec.Scope, spec.FS, scopePath, steps, all)
		})
		if err != nil {
			return results, err
		}
		results = append(results, res)
	}
	return results, nil
}

// MigrateStatus returns the ordered migration statuses across all 10 platform module scopes.
func MigrateStatus(ctx context.Context, dbPath string) ([]migrate.MigrationStatus, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	normalized := normalizeBaseDBPath(dbPath)
	if isMemorySQLiteDSN(normalized) {
		db, err := openScopeMigrationDB(ctx, normalized, true, true)
		if err != nil {
			return nil, err
		}
		defer func() { _ = db.Close() }()
		return MigrateStatusDB(ctx, db)
	}

	statuses := make([]migrate.MigrationStatus, 0, len(stackMigrationScopes))
	for _, spec := range stackMigrationScopes {
		scopePath := ScopeDBPath(normalized, spec.Scope)
		scopeStatuses, err := withScopeStatusDB(ctx, scopePath, false, spec.EnableVec, func(db *sql.DB) ([]migrate.MigrationStatus, error) {
			return migrateScopeStatus(ctx, db, spec.Scope, spec.FS)
		})
		if err != nil {
			return statuses, err
		}
		statuses = append(statuses, scopeStatuses...)
	}
	return statuses, nil
}

// MigrateUpDB applies all pending migrations for all 10 scopes against a single shared SQLite *sql.DB.
func MigrateUpDB(ctx context.Context, db *sql.DB, dbLabel string) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if db == nil {
		return nil, errors.New("stack: sql.DB is required")
	}
	results := make([]ScopeMigrationResult, 0, len(stackMigrationScopes))
	for _, spec := range stackMigrationScopes {
		res, err := migrateScopeUp(ctx, db, spec.Scope, spec.FS, dbLabel)
		if err != nil {
			return results, err
		}
		results = append(results, res)
	}
	return results, nil
}

// MigrateDownDB reverts migrations for all 10 scopes against a single shared SQLite *sql.DB.
func MigrateDownDB(ctx context.Context, db *sql.DB, dbLabel string, steps int, all bool) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if db == nil {
		return nil, errors.New("stack: sql.DB is required")
	}
	if !all && steps < 0 {
		return nil, fmt.Errorf("stack: migrate down requires non-negative steps, got %d", steps)
	}
	results := make([]ScopeMigrationResult, 0, len(stackMigrationScopes))
	for _, spec := range stackMigrationScopes {
		res, err := migrateScopeDown(ctx, db, spec.Scope, spec.FS, dbLabel, steps, all)
		if err != nil {
			return results, err
		}
		results = append(results, res)
	}
	return results, nil
}

// MigrateStatusDB reports migration status for all 10 scopes against a single shared SQLite *sql.DB.
func MigrateStatusDB(ctx context.Context, db *sql.DB) ([]migrate.MigrationStatus, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if db == nil {
		return nil, errors.New("stack: sql.DB is required")
	}
	statuses := make([]migrate.MigrationStatus, 0, len(stackMigrationScopes))
	for _, spec := range stackMigrationScopes {
		scopeStatuses, err := migrateScopeStatus(ctx, db, spec.Scope, spec.FS)
		if err != nil {
			return statuses, err
		}
		statuses = append(statuses, scopeStatuses...)
	}
	return statuses, nil
}

func normalizeMigrateContext(ctx context.Context) (context.Context, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return ctx, nil
}

func normalizeBaseDBPath(dbPath string) string {
	trimmed := strings.TrimSpace(dbPath)
	if trimmed == "" {
		return ":memory:"
	}
	return trimmed
}

func withScopeDB(ctx context.Context, dsn string, isMem, enableVec bool, fn func(*sql.DB) (ScopeMigrationResult, error)) (ScopeMigrationResult, error) {
	db, err := openScopeMigrationDB(ctx, dsn, isMem, enableVec)
	if err != nil {
		return ScopeMigrationResult{}, err
	}
	defer func() { _ = db.Close() }()
	return fn(db)
}

func withScopeStatusDB(ctx context.Context, dsn string, isMem, enableVec bool, fn func(*sql.DB) ([]migrate.MigrationStatus, error)) ([]migrate.MigrationStatus, error) {
	db, err := openScopeMigrationDB(ctx, dsn, isMem, enableVec)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	return fn(db)
}

func openScopeMigrationDB(ctx context.Context, dsn string, isMem, enableVec bool) (*sql.DB, error) {
	if !isMem && !strings.HasPrefix(dsn, "file:") {
		if dir := filepath.Dir(dsn); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("stack: mkdir migration db dir %q: %w", dir, err)
			}
		}
	}

	var (
		db  *sql.DB
		err error
	)
	if enableVec {
		registerMigrateVecFuncsOnce.Do(func() {
			_ = engine.RegisterVectorFunctions(nil)
		})
		db, err = engine.Open(dsn)
		if err != nil {
			return nil, fmt.Errorf("stack: open sqlite-vec db %q: %w", dsn, err)
		}
		if err := vec.Register(db); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("stack: register sqlite-vec %q: %w", dsn, err)
		}
	} else {
		db, err = sql.Open("sqlite", dsn)
		if err != nil {
			return nil, fmt.Errorf("stack: open sqlite db %q: %w", dsn, err)
		}
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
			return nil, fmt.Errorf("stack: %s on %q: %w", p, dsn, err)
		}
	}
	return db, nil
}

func migrateScopeUp(ctx context.Context, db *sql.DB, scope string, fsys fs.FS, dbLabel string) (ScopeMigrationResult, error) {
	runner, err := migrate.New(db, scope, fsys)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: init migrator %s: %w", scope, err)
	}
	beforeVer, _, err := runner.Version(ctx)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: version before up %s: %w", scope, err)
	}
	applied, err := runner.Up(ctx)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: migrate up %s: %w", scope, err)
	}
	afterVer, pending, err := runner.Version(ctx)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: version after up %s: %w", scope, err)
	}
	return ScopeMigrationResult{
		Scope:         scope,
		DBPath:        dbLabel,
		BeforeVersion: beforeVer,
		AfterVersion:  afterVer,
		Applied:       applied,
		Pending:       pending,
	}, nil
}

func migrateScopeDown(ctx context.Context, db *sql.DB, scope string, fsys fs.FS, dbLabel string, steps int, all bool) (ScopeMigrationResult, error) {
	runner, err := migrate.New(db, scope, fsys)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: init migrator %s: %w", scope, err)
	}
	beforeVer, _, err := runner.Version(ctx)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: version before down %s: %w", scope, err)
	}
	var reverted int
	if all {
		reverted, err = runner.DownAll(ctx)
	} else {
		reverted, err = runner.Down(ctx, steps)
	}
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: migrate down %s: %w", scope, err)
	}
	if scope == "pkm" && reverted > 0 {
		vec.InvalidateCache("main._vec_pkm_vectors", "pkm")
	}
	afterVer, pending, err := runner.Version(ctx)
	if err != nil {
		return ScopeMigrationResult{}, fmt.Errorf("stack: version after down %s: %w", scope, err)
	}
	return ScopeMigrationResult{
		Scope:         scope,
		DBPath:        dbLabel,
		BeforeVersion: beforeVer,
		AfterVersion:  afterVer,
		Reverted:      reverted,
		Pending:       pending,
	}, nil
}

func migrateScopeStatus(ctx context.Context, db *sql.DB, scope string, fsys fs.FS) ([]migrate.MigrationStatus, error) {
	runner, err := migrate.New(db, scope, fsys)
	if err != nil {
		return nil, fmt.Errorf("stack: init migrator %s: %w", scope, err)
	}
	statuses, err := runner.Status(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: migrate status %s: %w", scope, err)
	}
	return statuses, nil
}
