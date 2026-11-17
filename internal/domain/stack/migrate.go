package stack

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/viant/sqlite-vec/vec"

	pkgdb "github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

// ScopeMigrationResult summarizes migration progress or rollback for a SQLite migration scope.
type ScopeMigrationResult struct {
	Scope         string `json:"scope"`
	DBPath        string `json:"dbPath"`
	BeforeVersion int64  `json:"beforeVersion"`
	AfterVersion  int64  `json:"afterVersion"`
	Applied       int    `json:"applied"`
	Reverted      int    `json:"reverted"`
	Pending       int    `json:"pending"`
}

// MigrationScopes returns the ordered list of migration scopes coordinated by stack.
func MigrationScopes() []string {
	return []string{pkgdb.PlatformScope}
}

// MigrateUp applies all pending platform SQL migrations on the unified SQLite database.
func MigrateUp(ctx context.Context, dbPath string) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	normalized := normalizeBaseDBPath(dbPath)
	pool, err := pkgdb.OpenPool(ctx, normalized)
	if err != nil {
		return nil, fmt.Errorf("stack: open migration db %q: %w", normalized, err)
	}
	defer func() { _ = pool.Close() }()
	return MigrateUpDB(ctx, pool.WriteDB, normalized)
}

// MigrateDown reverts migrations on the unified platform SQLite database (either all applied versions or up to steps).
func MigrateDown(ctx context.Context, dbPath string, steps int, all bool) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if err := validateDownSteps(steps, all); err != nil {
		return nil, err
	}
	normalized := normalizeBaseDBPath(dbPath)
	pool, err := pkgdb.OpenPool(ctx, normalized)
	if err != nil {
		return nil, fmt.Errorf("stack: open migration db %q: %w", normalized, err)
	}
	defer func() { _ = pool.Close() }()
	return MigrateDownDB(ctx, pool.WriteDB, normalized, steps, all)
}

// MigrateStatus returns the ordered migration statuses for all 11 platform migrations.
func MigrateStatus(ctx context.Context, dbPath string) ([]migrate.MigrationStatus, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	normalized := normalizeBaseDBPath(dbPath)
	pool, err := pkgdb.OpenPool(ctx, normalized)
	if err != nil {
		return nil, fmt.Errorf("stack: open migration db %q: %w", normalized, err)
	}
	defer func() { _ = pool.Close() }()
	return MigrateStatusDB(ctx, pool.WriteDB)
}

// MigrateUpDB applies all pending platform migrations against writeDB.
func MigrateUpDB(ctx context.Context, writeDB *sql.DB, dbLabel string) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if writeDB == nil {
		return nil, errors.New("stack: sql.DB is required")
	}
	runner, err := migrate.New(writeDB, pkgdb.PlatformScope, pkgdb.MigrationsFS)
	if err != nil {
		return nil, fmt.Errorf("stack: init migrator %s: %w", pkgdb.PlatformScope, err)
	}
	beforeVer, _, err := runner.Version(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: version before up %s: %w", pkgdb.PlatformScope, err)
	}
	applied, err := runner.Up(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: migrate up %s: %w", pkgdb.PlatformScope, err)
	}
	afterVer, pending, err := runner.Version(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: version after up %s: %w", pkgdb.PlatformScope, err)
	}
	return []ScopeMigrationResult{{
		Scope:         pkgdb.PlatformScope,
		DBPath:        dbLabel,
		BeforeVersion: beforeVer,
		AfterVersion:  afterVer,
		Applied:       applied,
		Pending:       pending,
	}}, nil
}

// MigrateDownDB reverts platform migrations against writeDB (all applied versions when all is true, or up to steps).
func MigrateDownDB(ctx context.Context, writeDB *sql.DB, dbLabel string, steps int, all bool) ([]ScopeMigrationResult, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if writeDB == nil {
		return nil, errors.New("stack: sql.DB is required")
	}
	if err := validateDownSteps(steps, all); err != nil {
		return nil, err
	}
	runner, err := migrate.New(writeDB, pkgdb.PlatformScope, pkgdb.MigrationsFS)
	if err != nil {
		return nil, fmt.Errorf("stack: init migrator %s: %w", pkgdb.PlatformScope, err)
	}
	beforeVer, _, err := runner.Version(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: version before down %s: %w", pkgdb.PlatformScope, err)
	}
	var reverted int
	if all {
		reverted, err = runner.DownAll(ctx)
	} else {
		reverted, err = runner.Down(ctx, steps)
	}
	if err != nil {
		return nil, fmt.Errorf("stack: migrate down %s: %w", pkgdb.PlatformScope, err)
	}
	if reverted > 0 {
		vec.InvalidateCache("main._vec_pkm_vectors", "pkm")
	}
	afterVer, pending, err := runner.Version(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: version after down %s: %w", pkgdb.PlatformScope, err)
	}
	return []ScopeMigrationResult{{
		Scope:         pkgdb.PlatformScope,
		DBPath:        dbLabel,
		BeforeVersion: beforeVer,
		AfterVersion:  afterVer,
		Reverted:      reverted,
		Pending:       pending,
	}}, nil
}

// MigrateStatusDB reports migration status for all 11 platform migrations against writeDB.
func MigrateStatusDB(ctx context.Context, writeDB *sql.DB) ([]migrate.MigrationStatus, error) {
	ctx, err := normalizeMigrateContext(ctx)
	if err != nil {
		return nil, err
	}
	if writeDB == nil {
		return nil, errors.New("stack: sql.DB is required")
	}
	runner, err := migrate.New(writeDB, pkgdb.PlatformScope, pkgdb.MigrationsFS)
	if err != nil {
		return nil, fmt.Errorf("stack: init migrator %s: %w", pkgdb.PlatformScope, err)
	}
	statuses, err := runner.Status(ctx)
	if err != nil {
		return nil, fmt.Errorf("stack: migrate status %s: %w", pkgdb.PlatformScope, err)
	}
	return statuses, nil
}

func validateDownSteps(steps int, all bool) error {
	if !all && steps < 0 {
		return fmt.Errorf("stack: migrate down requires non-negative steps, got %d", steps)
	}
	return nil
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
