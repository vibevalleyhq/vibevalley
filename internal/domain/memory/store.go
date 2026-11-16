package memory

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var memorySchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS memory_heads (
		scope_id TEXT PRIMARY KEY,
		active_version INTEGER NOT NULL DEFAULT 0,
		next_version INTEGER NOT NULL DEFAULT 1,
		updated_at_ms INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS memory_versions (
		scope_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		parent_version INTEGER NOT NULL DEFAULT 0,
		kind TEXT NOT NULL,
		status TEXT NOT NULL,
		summary TEXT NOT NULL DEFAULT '',
		session_id TEXT NOT NULL DEFAULT '',
		created_at_ms INTEGER NOT NULL,
		PRIMARY KEY (scope_id, version)
	)`,

	`CREATE TABLE IF NOT EXISTS memory_version_files (
		scope_id TEXT NOT NULL,
		version INTEGER NOT NULL,
		rel_path TEXT NOT NULL,
		file_version INTEGER NOT NULL,
		sha256 TEXT NOT NULL,
		content BLOB NOT NULL,
		updated_at_ms INTEGER NOT NULL,
		PRIMARY KEY (scope_id, version, rel_path)
	)`,

	`CREATE TABLE IF NOT EXISTS memory_conflicts (
		conflict_id TEXT PRIMARY KEY,
		scope_id TEXT NOT NULL,
		rel_path TEXT NOT NULL,
		base_version INTEGER NOT NULL,
		server_version INTEGER NOT NULL,
		conflict_rel_path TEXT NOT NULL,
		uploaded_sha256 TEXT NOT NULL,
		content BLOB NOT NULL,
		session_id TEXT NOT NULL DEFAULT '',
		resolved INTEGER NOT NULL DEFAULT 0,
		resolution TEXT NOT NULL DEFAULT '',
		created_at_ms INTEGER NOT NULL,
		resolved_at_ms INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS memory_conflicts_scope_idx ON memory_conflicts(scope_id, resolved, created_at_ms)`,

	`CREATE TABLE IF NOT EXISTS memory_dreams (
		proposal_id TEXT PRIMARY KEY,
		scope_id TEXT NOT NULL,
		base_version INTEGER NOT NULL,
		candidate_version INTEGER NOT NULL,
		deduplicated_count INTEGER NOT NULL DEFAULT 0,
		summary TEXT NOT NULL,
		status TEXT NOT NULL,
		runner_session_id TEXT NOT NULL DEFAULT '',
		previous_active_version INTEGER NOT NULL DEFAULT 0,
		created_at_ms INTEGER NOT NULL,
		resolved_at_ms INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS memory_dreams_scope_idx ON memory_dreams(scope_id, created_at_ms)`,

	`CREATE TABLE IF NOT EXISTS memory_inbox (
		id TEXT PRIMARY KEY,
		scope_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		title TEXT NOT NULL,
		summary TEXT NOT NULL,
		session_id TEXT NOT NULL DEFAULT '',
		issue_id TEXT NOT NULL DEFAULT '',
		proposal_id TEXT NOT NULL DEFAULT '',
		conflict_id TEXT NOT NULL DEFAULT '',
		resolved INTEGER NOT NULL DEFAULT 0,
		created_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS memory_inbox_scope_idx ON memory_inbox(scope_id, resolved, created_at_ms)`,
}

// StoreOption configures a versioned memory Store.
type StoreOption func(*storeConfig)

type storeConfig struct {
	now          func() int64
	beforeCommit func() error
}

// WithClock overrides the millisecond timestamp source used for version and dream records.
func WithClock(now func() int64) StoreOption {
	return func(c *storeConfig) {
		if now != nil {
			c.now = now
		}
	}
}

// WithBeforeCommitHook installs a hook executed immediately before SQLite Commit in dream/snapshot transactions.
func WithBeforeCommitHook(fn func() error) StoreOption {
	return func(c *storeConfig) {
		c.beforeCommit = fn
	}
}

// Store persists immutable memory snapshot versions, mount conflict branches,
// and Phase 4 Dreaming Pipeline proposals over SQLite.
type Store struct {
	writeDB      *sql.DB
	readDB       *sql.DB
	sameDB       bool
	now          func() int64
	beforeCommit func() error
	idSeq        atomic.Int64
	mu           sync.Mutex
	closed       atomic.Bool
}

// OpenStore opens or creates a SQLite-backed versioned memory Store.
func OpenStore(ctx context.Context, dsn string, opts ...StoreOption) (*Store, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(dsn) == "" {
		dsn = ":memory:"
	}

	cfg := storeConfig{
		now: func() int64 { return time.Now().UnixMilli() },
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	isMem := dsn == ":memory:" || strings.Contains(dsn, "mode=memory") || strings.Contains(dsn, ":memory:")
	writeDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("memory: open sqlite writer: %w", err)
	}
	writeDB.SetMaxOpenConns(1)

	pragmas := []string{
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
		"PRAGMA synchronous=NORMAL",
	}
	if !isMem {
		pragmas = append([]string{"PRAGMA journal_mode=WAL"}, pragmas...)
	}
	for _, p := range pragmas {
		if _, err := writeDB.ExecContext(ctx, p); err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("memory: %s: %w", p, err)
		}
	}

	for _, ddl := range memorySchemaDDL {
		if _, err := writeDB.ExecContext(ctx, ddl); err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("memory: apply schema: %w", err)
		}
	}

	var readDB *sql.DB
	sameDB := false
	if isMem {
		readDB = writeDB
		sameDB = true
	} else {
		sep := "?"
		if strings.Contains(dsn, "?") {
			sep = "&"
		}
		readDSN := dsn + sep + "_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
		readDB, err = sql.Open("sqlite", readDSN)
		if err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("memory: open sqlite reader: %w", err)
		}
		readDB.SetMaxOpenConns(4)
	}

	return &Store{
		writeDB:      writeDB,
		readDB:       readDB,
		sameDB:       sameDB,
		now:          cfg.now,
		beforeCommit: cfg.beforeCommit,
	}, nil
}

// Close closes the underlying SQLite connections.
func (s *Store) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	var firstErr error
	if !s.sameDB && s.readDB != nil {
		if err := s.readDB.Close(); err != nil {
			firstErr = err
		}
	}
	if s.writeDB != nil {
		if err := s.writeDB.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// DB exposes the read *sql.DB handle for diagnostics.
func (s *Store) DB() *sql.DB {
	return s.readDB
}

func (s *Store) nextID(prefix string) string {
	n := s.idSeq.Add(1)
	return fmt.Sprintf("%s-%d-%d", prefix, s.now(), n)
}

// ActiveSnapshot returns the current active immutable memory snapshot for scopeID.
// If scopeID has no committed versions yet, an empty Version=0 snapshot is returned.
func (s *Store) ActiveSnapshot(ctx context.Context, scopeID string) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}
	scope := normalizeScopeID(scopeID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}
	return s.loadActiveSnapshotLocked(ctx, s.readDB, scope)
}

// GetVersion returns a specific immutable snapshot version for scopeID.
func (s *Store) GetVersion(ctx context.Context, scopeID string, version int64) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}
	if version <= 0 {
		return Snapshot{}, ErrNotFound
	}
	scope := normalizeScopeID(scopeID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}
	return s.loadVersionLocked(ctx, s.readDB, scope, version)
}

// ListVersions returns all immutable snapshot versions for scopeID ordered by version ascending.
func (s *Store) ListVersions(ctx context.Context, scopeID string) ([]Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	scope := normalizeScopeID(scopeID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}

	rows, err := s.readDB.QueryContext(ctx, `
		SELECT version, parent_version, kind, status, summary, session_id, created_at_ms
		FROM memory_versions
		WHERE scope_id = ?
		ORDER BY version ASC`, scope,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Snapshot
	for rows.Next() {
		var snap Snapshot
		var kindStr, statusStr string
		snap.ScopeID = scope
		if err := rows.Scan(&snap.Version, &snap.ParentVersion, &kindStr, &statusStr, &snap.Summary, &snap.SessionID, &snap.CreatedAtMs); err != nil {
			return nil, err
		}
		snap.Kind = VersionKind(kindStr)
		snap.Status = VersionStatus(statusStr)
		out = append(out, snap)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range out {
		files, err := loadVersionFiles(ctx, s.readDB, scope, out[i].Version)
		if err != nil {
			return nil, err
		}
		out[i].Files = files
	}
	return out, nil
}

// CommitFiles atomically writes a new immutable snapshot version by applying file updates and deletions
// onto the active version.
func (s *Store) CommitFiles(ctx context.Context, req CommitRequest) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}
	scope := normalizeScopeID(req.ScopeID)

	normalized := make([]MemoryFileInput, len(req.Files))
	seen := make(map[string]bool, len(req.Files))
	for i, f := range req.Files {
		rel, err := normalizeMemoryRelPath(f.RelPath)
		if err != nil {
			return Snapshot{}, fmt.Errorf("%w: invalid relPath %q", ErrInvalidArgument, f.RelPath)
		}
		if seen[rel] {
			return Snapshot{}, fmt.Errorf("%w: duplicate relPath %q", ErrInvalidArgument, rel)
		}
		seen[rel] = true
		normalized[i] = MemoryFileInput{
			RelPath:     rel,
			BaseVersion: f.BaseVersion,
			Content:     cloneBytes(f.Content),
		}
	}

	deletes := make(map[string]bool, len(req.DeletePaths))
	for _, dp := range req.DeletePaths {
		rel, err := normalizeMemoryRelPath(dp)
		if err != nil {
			return Snapshot{}, fmt.Errorf("%w: invalid delete path %q", ErrInvalidArgument, dp)
		}
		deletes[rel] = true
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return Snapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, tx, scope, nowMs)
	if err != nil {
		return Snapshot{}, err
	}
	if req.ExpectedVersion > 0 && head.activeVersion != req.ExpectedVersion {
		return Snapshot{}, fmt.Errorf("%w: expected version %d, active is %d", ErrConflict, req.ExpectedVersion, head.activeVersion)
	}

	curFiles, err := loadActiveFileMapTx(ctx, tx, scope, head.activeVersion)
	if err != nil {
		return Snapshot{}, err
	}

	nextFiles := make(map[string]MemoryFile, len(curFiles)+len(normalized))
	for k, v := range curFiles {
		if !deletes[k] {
			nextFiles[k] = cloneMemoryFile(v)
		}
	}

	for _, f := range normalized {
		existing, exists := curFiles[f.RelPath]
		if f.BaseVersion > 0 && (!exists || existing.Version != f.BaseVersion) {
			curVer := int64(0)
			if exists {
				curVer = existing.Version
			}
			return Snapshot{}, fmt.Errorf("%w: %s baseVersion=%d activeFileVersion=%d", ErrConflict, f.RelPath, f.BaseVersion, curVer)
		}
		newSHA := sha256Hex(f.Content)
		fileVer := int64(1)
		updatedMs := nowMs
		if exists {
			if existing.SHA256 == newSHA {
				fileVer = existing.Version
				updatedMs = existing.UpdatedAtMs
			} else {
				fileVer = existing.Version + 1
			}
		}
		nextFiles[f.RelPath] = MemoryFile{
			RelPath:     f.RelPath,
			Version:     fileVer,
			SHA256:      newSHA,
			Content:     f.Content,
			UpdatedAtMs: updatedMs,
		}
	}

	kind := VersionManual
	if head.activeVersion == 0 {
		kind = VersionInit
	}
	snap, err := writeNewActiveVersionTx(ctx, tx, scope, head, kind, req.Summary, req.SessionID, nextFiles, nowMs)
	if err != nil {
		return Snapshot{}, err
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return Snapshot{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Snapshot{}, err
	}
	return cloneSnapshot(snap), nil
}

// MaterializeFiles exports the active memory files as contract.MountFile entries for sandbox `.vibe/memory/`.
func (s *Store) MaterializeFiles(ctx context.Context, scopeID string) ([]contract.MountFile, error) {
	snap, err := s.ActiveSnapshot(ctx, scopeID)
	if err != nil {
		return nil, err
	}
	out := make([]contract.MountFile, len(snap.Files))
	for i, f := range snap.Files {
		out[i] = contract.MountFile{
			RelPath: f.RelPath,
			Version: f.Version,
			SHA256:  f.SHA256,
			Content: cloneBytes(f.Content),
		}
	}
	return out, nil
}

// PushMemories implements machine.MountRemote for DefaultScopeID.
func (s *Store) PushMemories(ctx context.Context, sessionID string, files []contract.MountFile) (machine.MountPushAck, error) {
	ack, _, err := s.ReconcileMounts(ctx, DefaultScopeID, sessionID, files)
	return ack, err
}

// MountRemoteFor returns a machine.MountRemote adapter bound to scopeID.
func (s *Store) MountRemoteFor(scopeID string) machine.MountRemote {
	return &scopedMountRemote{store: s, scopeID: normalizeScopeID(scopeID)}
}

type scopedMountRemote struct {
	store   *Store
	scopeID string
}

func (r *scopedMountRemote) PushMemories(ctx context.Context, sessionID string, files []contract.MountFile) (machine.MountPushAck, error) {
	ack, _, err := r.store.ReconcileMounts(ctx, r.scopeID, sessionID, files)
	return ack, err
}

// ReconcileMounts reconciles uploaded `.vibe/memory/` edits against the active snapshot version.
// Concurrent stale-base edits are never silently overwritten; instead they are preserved as immutable
// ConflictBranch records and returned in MountPushAck.Conflicts along with server's latest files.
func (s *Store) ReconcileMounts(ctx context.Context, scopeID, sessionID string, files []contract.MountFile) (machine.MountPushAck, []ConflictBranch, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return machine.MountPushAck{}, nil, err
	}
	if s.closed.Load() {
		return machine.MountPushAck{}, nil, ErrClosed
	}
	scope := normalizeScopeID(scopeID)
	if len(files) == 0 {
		return machine.MountPushAck{}, nil, nil
	}

	type cleanUpload struct {
		origRelPath string
		relPath     string
		baseVersion int64
		sha256      string
		content     []byte
	}
	uploads := make([]cleanUpload, len(files))
	for i, f := range files {
		rel, err := normalizeMemoryRelPath(f.RelPath)
		if err != nil {
			return machine.MountPushAck{}, nil, fmt.Errorf("%w: invalid mount path %q", ErrInvalidArgument, f.RelPath)
		}
		computed := sha256Hex(f.Content)
		if f.SHA256 != "" && strings.ToLower(f.SHA256) != computed {
			return machine.MountPushAck{}, nil, fmt.Errorf("%w: %s", ErrChecksumMismatch, f.RelPath)
		}
		uploads[i] = cleanUpload{
			origRelPath: f.RelPath,
			relPath:     rel,
			baseVersion: f.BaseVersion,
			sha256:      computed,
			content:     cloneBytes(f.Content),
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return machine.MountPushAck{}, nil, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return machine.MountPushAck{}, nil, err
	}
	defer func() { _ = tx.Rollback() }()

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, tx, scope, nowMs)
	if err != nil {
		return machine.MountPushAck{}, nil, err
	}
	curFiles, err := loadActiveFileMapTx(ctx, tx, scope, head.activeVersion)
	if err != nil {
		return machine.MountPushAck{}, nil, err
	}

	ack := machine.MountPushAck{
		AcceptedVersions: make(map[string]int64),
	}
	nextFiles := make(map[string]MemoryFile, len(curFiles)+len(uploads))
	for k, v := range curFiles {
		nextFiles[k] = cloneMemoryFile(v)
	}

	var conflicts []ConflictBranch
	mutatedActive := false
	latestAdded := make(map[string]bool)

	for _, u := range uploads {
		existing, exists := curFiles[u.relPath]

		switch {
		case !exists && u.baseVersion == 0:
			nextFiles[u.relPath] = MemoryFile{
				RelPath:     u.relPath,
				Version:     1,
				SHA256:      u.sha256,
				Content:     u.content,
				UpdatedAtMs: nowMs,
			}
			ack.AcceptedVersions[u.origRelPath] = 1
			mutatedActive = true

		case exists && existing.SHA256 == u.sha256:
			ack.AcceptedVersions[u.origRelPath] = existing.Version

		case exists && u.baseVersion == existing.Version:
			newVer := existing.Version + 1
			nextFiles[u.relPath] = MemoryFile{
				RelPath:     u.relPath,
				Version:     newVer,
				SHA256:      u.sha256,
				Content:     u.content,
				UpdatedAtMs: nowMs,
			}
			ack.AcceptedVersions[u.origRelPath] = newVer
			mutatedActive = true

		default:
			serverVer := int64(0)
			if exists {
				serverVer = existing.Version
			}
			conflictPath := conflictMountRelPath(u.relPath, serverVer, u.sha256)
			conflictID := s.nextID("conflict")
			cb := ConflictBranch{
				ConflictID:      conflictID,
				ScopeID:         scope,
				RelPath:         u.relPath,
				BaseVersion:     u.baseVersion,
				ServerVersion:   serverVer,
				ConflictRelPath: conflictPath,
				UploadedSHA256:  u.sha256,
				Content:         cloneBytes(u.content),
				SessionID:       sessionID,
				Resolved:        false,
				CreatedAtMs:     nowMs,
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO memory_conflicts (
					conflict_id, scope_id, rel_path, base_version, server_version,
					conflict_rel_path, uploaded_sha256, content, session_id,
					resolved, resolution, created_at_ms, resolved_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, 0)`,
				cb.ConflictID, cb.ScopeID, cb.RelPath, cb.BaseVersion, cb.ServerVersion,
				cb.ConflictRelPath, cb.UploadedSHA256, cb.Content, cb.SessionID, cb.CreatedAtMs,
			); err != nil {
				return machine.MountPushAck{}, nil, err
			}

			inboxID := s.nextID("inbox")
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO memory_inbox (
					id, scope_id, kind, title, summary, session_id, issue_id,
					proposal_id, conflict_id, resolved, created_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, 0, ?)`,
				inboxID, scope, string(contract.InboxMountConflict),
				"Memory mount conflict: "+u.relPath,
				fmt.Sprintf("Preserved concurrent edit at %s (base v%d vs server v%d)", conflictPath, u.baseVersion, serverVer),
				sessionID, cb.ConflictID, nowMs,
			); err != nil {
				return machine.MountPushAck{}, nil, err
			}

			conflicts = append(conflicts, cb)
			ack.Conflicts = append(ack.Conflicts, contract.MountConflict{
				RelPath:         u.origRelPath,
				BaseVersion:     u.baseVersion,
				ServerVersion:   serverVer,
				ConflictRelPath: conflictPath,
				UploadedSHA256:  u.sha256,
			})
			if exists && !latestAdded[u.relPath] {
				latestAdded[u.relPath] = true
				ack.Latest = append(ack.Latest, contract.MountFile{
					RelPath: u.origRelPath,
					Version: existing.Version,
					SHA256:  existing.SHA256,
					Content: cloneBytes(existing.Content),
				})
			}
		}
	}

	if mutatedActive {
		summary := fmt.Sprintf("mount sync from session %s", sessionID)
		if _, err := writeNewActiveVersionTx(ctx, tx, scope, head, VersionMountSync, summary, sessionID, nextFiles, nowMs); err != nil {
			return machine.MountPushAck{}, nil, err
		}
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return machine.MountPushAck{}, nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return machine.MountPushAck{}, nil, err
	}
	return ack, conflicts, nil
}

// ListConflicts returns preserved conflict branches for scopeID.
func (s *Store) ListConflicts(ctx context.Context, scopeID string, includeResolved bool) ([]ConflictBranch, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	scope := normalizeScopeID(scopeID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}

	query := `
		SELECT conflict_id, scope_id, rel_path, base_version, server_version,
		       conflict_rel_path, uploaded_sha256, content, session_id,
		       resolved, resolution, created_at_ms, resolved_at_ms
		FROM memory_conflicts
		WHERE scope_id = ?`
	if !includeResolved {
		query += ` AND resolved = 0`
	}
	query += ` ORDER BY created_at_ms ASC, conflict_id ASC`

	rows, err := s.readDB.QueryContext(ctx, query, scope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ConflictBranch
	for rows.Next() {
		var cb ConflictBranch
		var resolvedInt int
		var resStr string
		if err := rows.Scan(
			&cb.ConflictID, &cb.ScopeID, &cb.RelPath, &cb.BaseVersion, &cb.ServerVersion,
			&cb.ConflictRelPath, &cb.UploadedSHA256, &cb.Content, &cb.SessionID,
			&resolvedInt, &resStr, &cb.CreatedAtMs, &cb.ResolvedAtMs,
		); err != nil {
			return nil, err
		}
		cb.Resolved = resolvedInt != 0
		cb.Resolution = ConflictResolution(resStr)
		out = append(out, cb)
	}
	return out, rows.Err()
}

// ResolveConflict resolves a preserved conflict branch either keeping the server version,
// applying the conflict branch content, or applying explicit merged content as a new immutable version.
func (s *Store) ResolveConflict(ctx context.Context, conflictID string, resolution ConflictResolution, mergedContent []byte) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}
	if strings.TrimSpace(conflictID) == "" {
		return Snapshot{}, ErrInvalidArgument
	}
	switch resolution {
	case ResolutionKeepServer, ResolutionAcceptConflict, ResolutionMerge:
	default:
		return Snapshot{}, fmt.Errorf("%w: unsupported conflict resolution %q", ErrInvalidArgument, resolution)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return Snapshot{}, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return Snapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var cb ConflictBranch
	var resolvedInt int
	var resStr string
	err = tx.QueryRowContext(ctx, `
		SELECT conflict_id, scope_id, rel_path, base_version, server_version,
		       conflict_rel_path, uploaded_sha256, content, session_id,
		       resolved, resolution, created_at_ms, resolved_at_ms
		FROM memory_conflicts
		WHERE conflict_id = ?`, conflictID,
	).Scan(
		&cb.ConflictID, &cb.ScopeID, &cb.RelPath, &cb.BaseVersion, &cb.ServerVersion,
		&cb.ConflictRelPath, &cb.UploadedSHA256, &cb.Content, &cb.SessionID,
		&resolvedInt, &resStr, &cb.CreatedAtMs, &cb.ResolvedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	if err != nil {
		return Snapshot{}, err
	}
	if resolvedInt != 0 {
		return Snapshot{}, fmt.Errorf("%w: conflict %s already resolved", ErrInvalidTransition, conflictID)
	}

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, tx, cb.ScopeID, nowMs)
	if err != nil {
		return Snapshot{}, err
	}
	curFiles, err := loadActiveFileMapTx(ctx, tx, cb.ScopeID, head.activeVersion)
	if err != nil {
		return Snapshot{}, err
	}

	var resultSnap Snapshot
	if resolution == ResolutionKeepServer {
		resultSnap, err = s.loadVersionLocked(ctx, tx, cb.ScopeID, head.activeVersion)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return Snapshot{}, err
		}
		if errors.Is(err, ErrNotFound) {
			resultSnap = Snapshot{ScopeID: cb.ScopeID}
		}
	} else {
		nextContent := cloneBytes(cb.Content)
		if resolution == ResolutionMerge {
			nextContent = cloneBytes(mergedContent)
		}
		nextFiles := make(map[string]MemoryFile, len(curFiles)+1)
		for k, v := range curFiles {
			nextFiles[k] = cloneMemoryFile(v)
		}
		fileVer := int64(1)
		if cur, ok := curFiles[cb.RelPath]; ok {
			fileVer = cur.Version + 1
		}
		nextFiles[cb.RelPath] = MemoryFile{
			RelPath:     cb.RelPath,
			Version:     fileVer,
			SHA256:      sha256Hex(nextContent),
			Content:     nextContent,
			UpdatedAtMs: nowMs,
		}
		resultSnap, err = writeNewActiveVersionTx(
			ctx, tx, cb.ScopeID, head, VersionConflictResolution,
			fmt.Sprintf("resolved conflict %s (%s)", cb.ConflictID, resolution),
			cb.SessionID, nextFiles, nowMs,
		)
		if err != nil {
			return Snapshot{}, err
		}
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_conflicts
		SET resolved = 1, resolution = ?, resolved_at_ms = ?
		WHERE conflict_id = ?`,
		string(resolution), nowMs, cb.ConflictID,
	); err != nil {
		return Snapshot{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_inbox SET resolved = 1 WHERE conflict_id = ?`, cb.ConflictID,
	); err != nil {
		return Snapshot{}, err
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return Snapshot{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Snapshot{}, err
	}
	return cloneSnapshot(resultSnap), nil
}

// ListInbox returns actionable inbox entries (dream proposals and mount conflicts) for scopeID.
func (s *Store) ListInbox(ctx context.Context, scopeID string, includeResolved bool) ([]contract.InboxItemView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	scope := normalizeScopeID(scopeID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}

	query := `
		SELECT id, kind, title, summary, session_id, issue_id, resolved, created_at_ms
		FROM memory_inbox
		WHERE scope_id = ?`
	if !includeResolved {
		query += ` AND resolved = 0`
	}
	query += ` ORDER BY created_at_ms ASC, id ASC`

	rows, err := s.readDB.QueryContext(ctx, query, scope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []contract.InboxItemView
	for rows.Next() {
		var item contract.InboxItemView
		var kindStr string
		var resolvedInt int
		if err := rows.Scan(
			&item.ID, &kindStr, &item.Title, &item.Summary,
			&item.SessionID, &item.IssueID, &resolvedInt, &item.CreatedAtMs,
		); err != nil {
			return nil, err
		}
		item.Kind = contract.InboxItemKind(kindStr)
		item.Resolved = resolvedInt != 0
		out = append(out, item)
	}
	return out, rows.Err()
}

type queryable interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type headRow struct {
	activeVersion int64
	nextVersion   int64
}

func ensureHeadTx(ctx context.Context, q queryable, scope string, nowMs int64) (headRow, error) {
	if _, err := q.ExecContext(ctx, `
		INSERT OR IGNORE INTO memory_heads (scope_id, active_version, next_version, updated_at_ms)
		VALUES (?, 0, 1, ?)`, scope, nowMs,
	); err != nil {
		return headRow{}, err
	}
	var h headRow
	if err := q.QueryRowContext(ctx, `
		SELECT active_version, next_version
		FROM memory_heads
		WHERE scope_id = ?`, scope,
	).Scan(&h.activeVersion, &h.nextVersion); err != nil {
		return headRow{}, err
	}
	return h, nil
}

func (s *Store) loadActiveSnapshotLocked(ctx context.Context, q queryable, scope string) (Snapshot, error) {
	var activeVer int64
	err := q.QueryRowContext(ctx, `SELECT active_version FROM memory_heads WHERE scope_id = ?`, scope).Scan(&activeVer)
	if errors.Is(err, sql.ErrNoRows) || activeVer == 0 {
		return Snapshot{ScopeID: scope, Version: 0, Status: VersionStatusActive}, nil
	}
	if err != nil {
		return Snapshot{}, err
	}
	return s.loadVersionLocked(ctx, q, scope, activeVer)
}

func (s *Store) loadVersionLocked(ctx context.Context, q queryable, scope string, version int64) (Snapshot, error) {
	var snap Snapshot
	var kindStr, statusStr string
	err := q.QueryRowContext(ctx, `
		SELECT scope_id, version, parent_version, kind, status, summary, session_id, created_at_ms
		FROM memory_versions
		WHERE scope_id = ? AND version = ?`, scope, version,
	).Scan(&snap.ScopeID, &snap.Version, &snap.ParentVersion, &kindStr, &statusStr, &snap.Summary, &snap.SessionID, &snap.CreatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	if err != nil {
		return Snapshot{}, err
	}
	snap.Kind = VersionKind(kindStr)
	snap.Status = VersionStatus(statusStr)

	files, err := loadVersionFiles(ctx, q, scope, version)
	if err != nil {
		return Snapshot{}, err
	}
	snap.Files = files
	return snap, nil
}

func loadVersionFiles(ctx context.Context, q queryable, scope string, version int64) ([]MemoryFile, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT rel_path, file_version, sha256, content, updated_at_ms
		FROM memory_version_files
		WHERE scope_id = ? AND version = ?
		ORDER BY rel_path ASC`, scope, version,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []MemoryFile
	for rows.Next() {
		var f MemoryFile
		if err := rows.Scan(&f.RelPath, &f.Version, &f.SHA256, &f.Content, &f.UpdatedAtMs); err != nil {
			return nil, err
		}
		f.Content = cloneBytes(f.Content)
		files = append(files, f)
	}
	return files, rows.Err()
}

func loadActiveFileMapTx(ctx context.Context, q queryable, scope string, activeVersion int64) (map[string]MemoryFile, error) {
	out := make(map[string]MemoryFile)
	if activeVersion <= 0 {
		return out, nil
	}
	files, err := loadVersionFiles(ctx, q, scope, activeVersion)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		out[f.RelPath] = f
	}
	return out, nil
}

func writeNewActiveVersionTx(
	ctx context.Context,
	tx *sql.Tx,
	scope string,
	head headRow,
	kind VersionKind,
	summary string,
	sessionID string,
	files map[string]MemoryFile,
	nowMs int64,
) (Snapshot, error) {
	newVer := head.nextVersion
	if head.activeVersion > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE memory_versions SET status = ? WHERE scope_id = ? AND version = ?`,
			string(VersionStatusSuperseded), scope, head.activeVersion,
		); err != nil {
			return Snapshot{}, err
		}
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO memory_versions (
			scope_id, version, parent_version, kind, status, summary, session_id, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		scope, newVer, head.activeVersion, string(kind), string(VersionStatusActive), summary, sessionID, nowMs,
	); err != nil {
		return Snapshot{}, err
	}

	orderedPaths := make([]string, 0, len(files))
	for p := range files {
		orderedPaths = append(orderedPaths, p)
	}
	sort.Strings(orderedPaths)

	sliceFiles := make([]MemoryFile, 0, len(orderedPaths))
	for _, p := range orderedPaths {
		f := files[p]
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO memory_version_files (
				scope_id, version, rel_path, file_version, sha256, content, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			scope, newVer, f.RelPath, f.Version, f.SHA256, f.Content, f.UpdatedAtMs,
		); err != nil {
			return Snapshot{}, err
		}
		sliceFiles = append(sliceFiles, cloneMemoryFile(f))
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_heads
		SET active_version = ?, next_version = ?, updated_at_ms = ?
		WHERE scope_id = ?`,
		newVer, newVer+1, nowMs, scope,
	); err != nil {
		return Snapshot{}, err
	}

	return Snapshot{
		ScopeID:       scope,
		Version:       newVer,
		ParentVersion: head.activeVersion,
		Kind:          kind,
		Status:        VersionStatusActive,
		Summary:       summary,
		SessionID:     sessionID,
		CreatedAtMs:   nowMs,
		Files:         sliceFiles,
	}, nil
}
