// Package migrate implements a deterministic, zero-external-dependency SQL
// migration engine for SQLite and PostgreSQL databases using paired
// <NNNN>_<name>.up.sql and <NNNN>_<name>.down.sql scripts.
package migrate

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Dialect selects SQL placeholder syntax for the migration tracking table.
type Dialect int

const (
	DialectSQLite Dialect = iota
	DialectPostgres
)

// String returns the human-readable name of the SQL dialect.
func (d Dialect) String() string {
	switch d {
	case DialectSQLite:
		return "sqlite"
	case DialectPostgres:
		return "postgres"
	default:
		return fmt.Sprintf("dialect(%d)", int(d))
	}
}

var (
	ErrInvalidMigration     = errors.New("migrate: invalid migration")
	ErrMissingUpMigration   = errors.New("migrate: missing up migration")
	ErrMissingDownMigration = errors.New("migrate: missing down migration")
	ErrChecksumMismatch     = errors.New("migrate: checksum mismatch")
	ErrEmptyMigrations      = errors.New("migrate: no migrations found")
)

const defaultMigrationsDir = "migrations"

// Migration holds a validated, paired up/down SQL migration and its SHA-256 checksum.
type Migration struct {
	Version  int64
	Name     string
	UpSQL    string
	DownSQL  string
	Checksum string
}

// MigrationStatus reports whether a migration version is applied for a scope.
type MigrationStatus struct {
	Scope       string
	Version     int64
	Name        string
	Checksum    string
	Applied     bool
	AppliedAtMs int64
}

type options struct {
	dir     string
	dialect Dialect
	nowMs   func() int64
}

// Option configures a migration Runner.
type Option func(*options)

// WithDir overrides the directory inside fsys containing migration files (default "migrations").
func WithDir(dir string) Option {
	return func(o *options) {
		if strings.TrimSpace(dir) != "" {
			o.dir = dir
		}
	}
}

// WithDialect selects the SQL placeholder dialect (default DialectSQLite).
func WithDialect(d Dialect) Option {
	return func(o *options) {
		o.dialect = d
	}
}

// WithClock overrides the millisecond timestamp source used when recording applied migrations.
func WithClock(nowMs func() int64) Option {
	return func(o *options) {
		if nowMs != nil {
			o.nowMs = nowMs
		}
	}
}

type migrationPair struct {
	upFile   string
	upName   string
	downFile string
	downName string
}

// ParseFS loads, validates, pairs, and sorts migrations from dir within fsys.
func ParseFS(fsys fs.FS, dir string) ([]Migration, error) {
	if fsys == nil {
		return nil, fmt.Errorf("%w: filesystem is nil", ErrInvalidMigration)
	}
	if strings.TrimSpace(dir) == "" {
		dir = defaultMigrationsDir
	}
	dir = path.Clean(dir)

	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("migrate: read dir %q: %w", dir, err)
	}

	pairs := make(map[int64]*migrationPair)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		filename := entry.Name()
		if strings.HasPrefix(filename, ".") && !strings.HasSuffix(filename, ".sql") {
			continue
		}

		ver, migName, isUp, ok := parseFilename(filename)
		if !ok {
			return nil, fmt.Errorf("%w: invalid filename %q (expected <NNNN>_<name>.up.sql or .down.sql)", ErrInvalidMigration, filename)
		}

		pair := pairs[ver]
		if pair == nil {
			pair = &migrationPair{}
			pairs[ver] = pair
		}
		if isUp {
			if pair.upFile != "" {
				return nil, fmt.Errorf("%w: duplicate up migration for version %d (%q and %q)", ErrInvalidMigration, ver, pair.upFile, filename)
			}
			pair.upFile = filename
			pair.upName = migName
		} else {
			if pair.downFile != "" {
				return nil, fmt.Errorf("%w: duplicate down migration for version %d (%q and %q)", ErrInvalidMigration, ver, pair.downFile, filename)
			}
			pair.downFile = filename
			pair.downName = migName
		}
	}

	if len(pairs) == 0 {
		return nil, ErrEmptyMigrations
	}

	versions := make([]int64, 0, len(pairs))
	for ver := range pairs {
		versions = append(versions, ver)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })

	migrations := make([]Migration, 0, len(versions))
	for _, ver := range versions {
		pair := pairs[ver]
		if pair.upFile == "" {
			return nil, fmt.Errorf("%w: version %d (%s)", ErrMissingUpMigration, ver, pair.downName)
		}
		if pair.downFile == "" {
			return nil, fmt.Errorf("%w: version %d (%s)", ErrMissingDownMigration, ver, pair.upName)
		}
		if pair.upName != pair.downName {
			return nil, fmt.Errorf("%w: version %d name mismatch (%q vs %q)", ErrInvalidMigration, ver, pair.upName, pair.downName)
		}

		upBytes, err := fs.ReadFile(fsys, path.Join(dir, pair.upFile))
		if err != nil {
			return nil, fmt.Errorf("migrate: read %q: %w", pair.upFile, err)
		}
		downBytes, err := fs.ReadFile(fsys, path.Join(dir, pair.downFile))
		if err != nil {
			return nil, fmt.Errorf("migrate: read %q: %w", pair.downFile, err)
		}

		upSQL := strings.TrimSpace(strings.TrimPrefix(string(upBytes), "\ufeff"))
		downSQL := strings.TrimSpace(strings.TrimPrefix(string(downBytes), "\ufeff"))

		if len(SplitStatements(upSQL)) == 0 {
			return nil, fmt.Errorf("%w: %q contains no executable SQL statements", ErrInvalidMigration, pair.upFile)
		}
		if len(SplitStatements(downSQL)) == 0 {
			return nil, fmt.Errorf("%w: %q contains no executable SQL statements", ErrInvalidMigration, pair.downFile)
		}

		sum := sha256.Sum256([]byte(upSQL))
		migrations = append(migrations, Migration{
			Version:  ver,
			Name:     pair.upName,
			UpSQL:    upSQL,
			DownSQL:  downSQL,
			Checksum: hex.EncodeToString(sum[:]),
		})
	}

	return migrations, nil
}

func parseFilename(filename string) (version int64, name string, isUp bool, ok bool) {
	var stem string
	switch {
	case strings.HasSuffix(filename, ".up.sql"):
		stem = strings.TrimSuffix(filename, ".up.sql")
		isUp = true
	case strings.HasSuffix(filename, ".down.sql"):
		stem = strings.TrimSuffix(filename, ".down.sql")
		isUp = false
	default:
		return 0, "", false, false
	}

	verStr, migName, hasSep := strings.Cut(stem, "_")
	if !hasSep || verStr == "" || migName == "" || strings.TrimSpace(migName) != migName {
		return 0, "", false, false
	}
	for i := 0; i < len(verStr); i++ {
		if verStr[i] < '0' || verStr[i] > '9' {
			return 0, "", false, false
		}
	}
	ver, err := strconv.ParseInt(verStr, 10, 64)
	if err != nil || ver <= 0 {
		return 0, "", false, false
	}
	return ver, migName, isUp, true
}

type preparedMigration struct {
	migration Migration
	upStmts   []string
	downStmts []string
}

// Runner applies and reverts scoped SQL migrations against a *sql.DB.
type Runner struct {
	db         *sql.DB
	scope      string
	dialect    Dialect
	nowMs      func() int64
	migrations []preparedMigration
	byVersion  map[int64]preparedMigration
}

// New constructs a Runner for scope using migrations loaded from fsys.
func New(db *sql.DB, scope string, fsys fs.FS, opts ...Option) (*Runner, error) {
	if db == nil {
		return nil, errors.New("migrate: sql.DB is required")
	}
	scope = strings.TrimSpace(scope)
	if scope == "" {
		return nil, errors.New("migrate: scope is required")
	}

	cfg := options{
		dir:     defaultMigrationsDir,
		dialect: DialectSQLite,
		nowMs:   func() int64 { return time.Now().UnixMilli() },
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if cfg.dialect != DialectSQLite && cfg.dialect != DialectPostgres {
		return nil, fmt.Errorf("migrate: unsupported dialect %d", cfg.dialect)
	}

	migs, err := ParseFS(fsys, cfg.dir)
	if err != nil {
		return nil, err
	}

	prepared := make([]preparedMigration, len(migs))
	byVersion := make(map[int64]preparedMigration, len(migs))
	for i, m := range migs {
		pm := preparedMigration{
			migration: m,
			upStmts:   SplitStatements(m.UpSQL),
			downStmts: SplitStatements(m.DownSQL),
		}
		prepared[i] = pm
		byVersion[m.Version] = pm
	}

	return &Runner{
		db:         db,
		scope:      scope,
		dialect:    cfg.dialect,
		nowMs:      cfg.nowMs,
		migrations: prepared,
		byVersion:  byVersion,
	}, nil
}

// Migrations returns a copy of the parsed migrations sorted ascending by Version.
func (r *Runner) Migrations() []Migration {
	out := make([]Migration, len(r.migrations))
	for i, pm := range r.migrations {
		out[i] = pm.migration
	}
	return out
}

type sqlExecutor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func (r *Runner) ph(index int) string {
	if r.dialect == DialectPostgres {
		return fmt.Sprintf("$%d", index)
	}
	return "?"
}

const createTrackingTableSQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
	scope TEXT NOT NULL,
	version BIGINT NOT NULL,
	name TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at_ms BIGINT NOT NULL,
	PRIMARY KEY (scope, version)
)`

// EnsureTrackingTable creates the schema_migrations table if it does not exist.
func (r *Runner) EnsureTrackingTable(ctx context.Context) error {
	if ctx == nil {
		return errors.New("migrate: nil context")
	}
	return r.ensureTrackingTable(ctx, r.db)
}

func (r *Runner) ensureTrackingTable(ctx context.Context, exec sqlExecutor) error {
	if _, err := exec.ExecContext(ctx, createTrackingTableSQL); err != nil {
		return fmt.Errorf("migrate: ensure tracking table: %w", err)
	}
	return nil
}

type appliedRecord struct {
	version     int64
	name        string
	checksum    string
	appliedAtMs int64
}

func (r *Runner) loadApplied(ctx context.Context, exec sqlExecutor, desc bool) ([]appliedRecord, error) {
	order := "ASC"
	if desc {
		order = "DESC"
	}
	query := fmt.Sprintf(
		`SELECT version, name, checksum, applied_at_ms FROM schema_migrations WHERE scope = %s ORDER BY version %s`,
		r.ph(1),
		order,
	)
	rows, err := exec.QueryContext(ctx, query, r.scope)
	if err != nil {
		return nil, fmt.Errorf("migrate: query applied migrations for scope %q: %w", r.scope, err)
	}
	defer rows.Close()

	var applied []appliedRecord
	for rows.Next() {
		var rec appliedRecord
		if err := rows.Scan(&rec.version, &rec.name, &rec.checksum, &rec.appliedAtMs); err != nil {
			return nil, fmt.Errorf("migrate: scan applied migration for scope %q: %w", r.scope, err)
		}
		applied = append(applied, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("migrate: iterate applied migrations for scope %q: %w", r.scope, err)
	}
	return applied, nil
}

// Up applies all pending migrations for this scope in ascending version order.
func (r *Runner) Up(ctx context.Context) (int, error) {
	return r.upLimit(ctx, -1)
}

// UpSteps applies up to n pending migrations for this scope in ascending version order.
func (r *Runner) UpSteps(ctx context.Context, n int) (int, error) {
	if n < 0 {
		return 0, fmt.Errorf("migrate: UpSteps requires non-negative steps, got %d", n)
	}
	return r.upLimit(ctx, n)
}

func (r *Runner) upLimit(ctx context.Context, limit int) (int, error) {
	if ctx == nil {
		return 0, errors.New("migrate: nil context")
	}

	conn, err := r.db.Conn(ctx)
	if err != nil {
		return 0, fmt.Errorf("migrate: acquire connection: %w", err)
	}
	defer conn.Close()

	if err := r.ensureTrackingTable(ctx, conn); err != nil {
		return 0, err
	}

	records, err := r.loadApplied(ctx, conn, false)
	if err != nil {
		return 0, err
	}

	appliedMap := make(map[int64]appliedRecord, len(records))
	for _, rec := range records {
		pm, ok := r.byVersion[rec.version]
		if !ok {
			return 0, fmt.Errorf("%w: scope %q applied version %d (%s) not found in migration files", ErrMissingUpMigration, r.scope, rec.version, rec.name)
		}
		if rec.checksum != pm.migration.Checksum {
			return 0, fmt.Errorf("%w: scope %q version %d (%s): recorded %s, current %s", ErrChecksumMismatch, r.scope, rec.version, pm.migration.Name, rec.checksum, pm.migration.Checksum)
		}
		appliedMap[rec.version] = rec
	}

	var pending []preparedMigration
	for _, pm := range r.migrations {
		if _, exists := appliedMap[pm.migration.Version]; !exists {
			pending = append(pending, pm)
		}
	}
	if limit >= 0 && len(pending) > limit {
		pending = pending[:limit]
	}

	insertSQL := fmt.Sprintf(
		`INSERT INTO schema_migrations (scope, version, name, checksum, applied_at_ms) VALUES (%s, %s, %s, %s, %s)`,
		r.ph(1), r.ph(2), r.ph(3), r.ph(4), r.ph(5),
	)

	appliedCount := 0
	for _, pm := range pending {
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return appliedCount, fmt.Errorf("migrate: begin up tx for scope %q version %d: %w", r.scope, pm.migration.Version, err)
		}

		for idx, stmt := range pm.upStmts {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				_ = tx.Rollback()
				return appliedCount, fmt.Errorf("migrate: apply scope %q version %d (%s) statement %d: %w", r.scope, pm.migration.Version, pm.migration.Name, idx+1, err)
			}
		}

		if _, err := tx.ExecContext(ctx, insertSQL, r.scope, pm.migration.Version, pm.migration.Name, pm.migration.Checksum, r.nowMs()); err != nil {
			_ = tx.Rollback()
			return appliedCount, fmt.Errorf("migrate: record scope %q version %d (%s): %w", r.scope, pm.migration.Version, pm.migration.Name, err)
		}

		if err := tx.Commit(); err != nil {
			return appliedCount, fmt.Errorf("migrate: commit up tx for scope %q version %d (%s): %w", r.scope, pm.migration.Version, pm.migration.Name, err)
		}
		appliedCount++
	}

	return appliedCount, nil
}

// Down reverts up to steps applied migrations for this scope in reverse version order.
func (r *Runner) Down(ctx context.Context, steps int) (int, error) {
	if steps < 0 {
		return 0, fmt.Errorf("migrate: Down requires non-negative steps, got %d", steps)
	}
	return r.downLimit(ctx, steps)
}

// DownAll reverts all applied migrations for this scope in reverse version order.
func (r *Runner) DownAll(ctx context.Context) (int, error) {
	return r.downLimit(ctx, -1)
}

func (r *Runner) downLimit(ctx context.Context, limit int) (int, error) {
	if ctx == nil {
		return 0, errors.New("migrate: nil context")
	}

	conn, err := r.db.Conn(ctx)
	if err != nil {
		return 0, fmt.Errorf("migrate: acquire connection: %w", err)
	}
	defer conn.Close()

	if err := r.ensureTrackingTable(ctx, conn); err != nil {
		return 0, err
	}

	records, err := r.loadApplied(ctx, conn, true)
	if err != nil {
		return 0, err
	}
	if limit >= 0 && len(records) > limit {
		records = records[:limit]
	}

	deleteSQL := fmt.Sprintf(
		`DELETE FROM schema_migrations WHERE scope = %s AND version = %s`,
		r.ph(1), r.ph(2),
	)

	revertedCount := 0
	for _, rec := range records {
		pm, ok := r.byVersion[rec.version]
		if !ok {
			return revertedCount, fmt.Errorf("%w: scope %q applied version %d (%s) not found in migration files", ErrMissingDownMigration, r.scope, rec.version, rec.name)
		}

		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return revertedCount, fmt.Errorf("migrate: begin down tx for scope %q version %d: %w", r.scope, rec.version, err)
		}

		for idx, stmt := range pm.downStmts {
			if _, err := tx.ExecContext(ctx, stmt); err != nil {
				_ = tx.Rollback()
				return revertedCount, fmt.Errorf("migrate: revert scope %q version %d (%s) statement %d: %w", r.scope, rec.version, pm.migration.Name, idx+1, err)
			}
		}

		if _, err := tx.ExecContext(ctx, deleteSQL, r.scope, rec.version); err != nil {
			_ = tx.Rollback()
			return revertedCount, fmt.Errorf("migrate: delete tracking row scope %q version %d: %w", r.scope, rec.version, err)
		}

		if err := tx.Commit(); err != nil {
			return revertedCount, fmt.Errorf("migrate: commit down tx for scope %q version %d: %w", r.scope, rec.version, err)
		}
		revertedCount++
	}

	return revertedCount, nil
}

// Version returns the highest applied migration version for this scope and the count of pending migrations.
func (r *Runner) Version(ctx context.Context) (current int64, pending int, err error) {
	if ctx == nil {
		return 0, 0, errors.New("migrate: nil context")
	}

	conn, err := r.db.Conn(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("migrate: acquire connection: %w", err)
	}
	defer conn.Close()

	if err := r.ensureTrackingTable(ctx, conn); err != nil {
		return 0, 0, err
	}

	records, err := r.loadApplied(ctx, conn, false)
	if err != nil {
		return 0, 0, err
	}

	appliedSet := make(map[int64]struct{}, len(records))
	for _, rec := range records {
		appliedSet[rec.version] = struct{}{}
		if rec.version > current {
			current = rec.version
		}
	}

	for _, pm := range r.migrations {
		if _, ok := appliedSet[pm.migration.Version]; !ok {
			pending++
		}
	}
	return current, pending, nil
}

// Status returns the ordered status of all migrations known to this runner's scope.
func (r *Runner) Status(ctx context.Context) ([]MigrationStatus, error) {
	if ctx == nil {
		return nil, errors.New("migrate: nil context")
	}

	conn, err := r.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("migrate: acquire connection: %w", err)
	}
	defer conn.Close()

	if err := r.ensureTrackingTable(ctx, conn); err != nil {
		return nil, err
	}

	records, err := r.loadApplied(ctx, conn, false)
	if err != nil {
		return nil, err
	}

	appliedMap := make(map[int64]appliedRecord, len(records))
	for _, rec := range records {
		appliedMap[rec.version] = rec
	}

	statuses := make([]MigrationStatus, 0, len(r.migrations)+len(records))
	seen := make(map[int64]struct{}, len(r.migrations))
	for _, pm := range r.migrations {
		seen[pm.migration.Version] = struct{}{}
		st := MigrationStatus{
			Scope:    r.scope,
			Version:  pm.migration.Version,
			Name:     pm.migration.Name,
			Checksum: pm.migration.Checksum,
		}
		if rec, ok := appliedMap[pm.migration.Version]; ok {
			st.Applied = true
			st.AppliedAtMs = rec.appliedAtMs
		}
		statuses = append(statuses, st)
	}

	for _, rec := range records {
		if _, ok := seen[rec.version]; ok {
			continue
		}
		statuses = append(statuses, MigrationStatus{
			Scope:       r.scope,
			Version:     rec.version,
			Name:        rec.name,
			Checksum:    rec.checksum,
			Applied:     true,
			AppliedAtMs: rec.appliedAtMs,
		})
	}

	sort.Slice(statuses, func(i, j int) bool { return statuses[i].Version < statuses[j].Version })
	return statuses, nil
}
