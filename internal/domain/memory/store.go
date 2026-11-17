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

	"github.com/vibevalleyhq/vibevalley/internal/machine"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

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
	readQ        *dbgen.Queries
	sameDB       bool
	ownsDB       bool
	now          func() int64
	beforeCommit func() error
	idSeq        atomic.Int64
	mu           sync.Mutex
	closed       atomic.Bool
}

func newStoreConfig(opts ...StoreOption) storeConfig {
	cfg := storeConfig{
		now: func() int64 { return time.Now().UnixMilli() },
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return cfg
}

// OpenStoreFromPool constructs a versioned memory Store backed by a caller-owned SQLite pool.
// Callers retain ownership of writeDB and readDB; Close marks the Store closed without closing either handle.
func OpenStoreFromPool(ctx context.Context, writeDB, readDB *sql.DB, isMem bool, opts ...StoreOption) (*Store, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if writeDB == nil {
		return nil, fmt.Errorf("%w: writeDB is required", ErrInvalidArgument)
	}
	if readDB == nil {
		readDB = writeDB
	}

	cfg := newStoreConfig(opts...)
	return &Store{
		writeDB:      writeDB,
		readDB:       readDB,
		readQ:        dbgen.New(readDB),
		sameDB:       isMem || readDB == writeDB,
		ownsDB:       false,
		now:          cfg.now,
		beforeCommit: cfg.beforeCommit,
	}, nil
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

	cfg := newStoreConfig(opts...)

	pool, err := db.OpenPool(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("memory: %w", err)
	}

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("memory: init migrations: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("memory: apply schema: %w", err)
	}

	return &Store{
		writeDB:      pool.WriteDB,
		readDB:       pool.ReadDB,
		readQ:        dbgen.New(pool.ReadDB),
		sameDB:       pool.SameDB,
		ownsDB:       true,
		now:          cfg.now,
		beforeCommit: cfg.beforeCommit,
	}, nil
}

// Close marks the Store closed and, when owned, closes the underlying SQLite connections.
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	if s.closed.Swap(true) {
		return nil
	}
	if !s.ownsDB {
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
	return s.loadActiveSnapshotLocked(ctx, s.readQ, scope)
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
	return s.loadVersionLocked(ctx, s.readQ, scope, version)
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

	rows, err := s.readQ.ListVersionsByScope(ctx, scope)
	if err != nil {
		return nil, err
	}

	out := make([]Snapshot, 0, len(rows))
	for _, r := range rows {
		out = append(out, Snapshot{
			ScopeID:       scope,
			Version:       r.Version,
			ParentVersion: r.ParentVersion,
			Kind:          VersionKind(r.Kind),
			Status:        VersionStatus(r.Status),
			Summary:       r.Summary,
			SessionID:     r.SessionID,
			CreatedAtMs:   r.CreatedAtMs,
		})
	}

	for i := range out {
		files, err := loadVersionFiles(ctx, s.readQ, scope, out[i].Version)
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
	q := dbgen.New(tx)

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, q, scope, nowMs)
	if err != nil {
		return Snapshot{}, err
	}
	if req.ExpectedVersion > 0 && head.activeVersion != req.ExpectedVersion {
		return Snapshot{}, fmt.Errorf("%w: expected version %d, active is %d", ErrConflict, req.ExpectedVersion, head.activeVersion)
	}

	curFiles, err := loadActiveFileMapTx(ctx, q, scope, head.activeVersion)
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
	snap, err := writeNewActiveVersionTx(ctx, q, scope, head, kind, req.Summary, req.SessionID, nextFiles, nowMs)
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
	q := dbgen.New(tx)

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, q, scope, nowMs)
	if err != nil {
		return machine.MountPushAck{}, nil, err
	}
	curFiles, err := loadActiveFileMapTx(ctx, q, scope, head.activeVersion)
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
			if err := q.InsertConflict(ctx, dbgen.InsertConflictParams{
				ConflictID:      cb.ConflictID,
				ScopeID:         cb.ScopeID,
				RelPath:         cb.RelPath,
				BaseVersion:     cb.BaseVersion,
				ServerVersion:   cb.ServerVersion,
				ConflictRelPath: cb.ConflictRelPath,
				UploadedSha256:  cb.UploadedSHA256,
				Content:         cb.Content,
				SessionID:       cb.SessionID,
				CreatedAtMs:     cb.CreatedAtMs,
			}); err != nil {
				return machine.MountPushAck{}, nil, err
			}

			inboxID := s.nextID("inbox")
			if err := q.InsertConflictInbox(ctx, dbgen.InsertConflictInboxParams{
				ID:          inboxID,
				ScopeID:     scope,
				Kind:        string(contract.InboxMountConflict),
				Title:       "Memory mount conflict: " + u.relPath,
				Summary:     fmt.Sprintf("Preserved concurrent edit at %s (base v%d vs server v%d)", conflictPath, u.baseVersion, serverVer),
				SessionID:   sessionID,
				ConflictID:  cb.ConflictID,
				CreatedAtMs: nowMs,
			}); err != nil {
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
		if _, err := writeNewActiveVersionTx(ctx, q, scope, head, VersionMountSync, summary, sessionID, nextFiles, nowMs); err != nil {
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

	var rows []dbgen.MemoryConflict
	var err error
	if includeResolved {
		rows, err = s.readQ.ListAllConflictsByScope(ctx, scope)
	} else {
		rows, err = s.readQ.ListUnresolvedConflictsByScope(ctx, scope)
	}
	if err != nil {
		return nil, err
	}

	out := make([]ConflictBranch, 0, len(rows))
	for _, r := range rows {
		out = append(out, conflictFromRow(r))
	}
	return out, nil
}

func conflictFromRow(r dbgen.MemoryConflict) ConflictBranch {
	return ConflictBranch{
		ConflictID:      r.ConflictID,
		ScopeID:         r.ScopeID,
		RelPath:         r.RelPath,
		BaseVersion:     r.BaseVersion,
		ServerVersion:   r.ServerVersion,
		ConflictRelPath: r.ConflictRelPath,
		UploadedSHA256:  r.UploadedSha256,
		Content:         r.Content,
		SessionID:       r.SessionID,
		Resolved:        r.Resolved != 0,
		Resolution:      ConflictResolution(r.Resolution),
		CreatedAtMs:     r.CreatedAtMs,
		ResolvedAtMs:    r.ResolvedAtMs,
	}
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
	q := dbgen.New(tx)

	row, err := q.GetConflictByID(ctx, conflictID)
	if errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	if err != nil {
		return Snapshot{}, err
	}
	if row.Resolved != 0 {
		return Snapshot{}, fmt.Errorf("%w: conflict %s already resolved", ErrInvalidTransition, conflictID)
	}
	cb := conflictFromRow(row)

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, q, cb.ScopeID, nowMs)
	if err != nil {
		return Snapshot{}, err
	}
	curFiles, err := loadActiveFileMapTx(ctx, q, cb.ScopeID, head.activeVersion)
	if err != nil {
		return Snapshot{}, err
	}

	var resultSnap Snapshot
	if resolution == ResolutionKeepServer {
		resultSnap, err = s.loadVersionLocked(ctx, q, cb.ScopeID, head.activeVersion)
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
			ctx, q, cb.ScopeID, head, VersionConflictResolution,
			fmt.Sprintf("resolved conflict %s (%s)", cb.ConflictID, resolution),
			cb.SessionID, nextFiles, nowMs,
		)
		if err != nil {
			return Snapshot{}, err
		}
	}

	if err := q.MarkConflictResolved(ctx, dbgen.MarkConflictResolvedParams{
		Resolution:   string(resolution),
		ResolvedAtMs: nowMs,
		ConflictID:   cb.ConflictID,
	}); err != nil {
		return Snapshot{}, err
	}
	if err := q.ResolveInboxByConflict(ctx, cb.ConflictID); err != nil {
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

	if includeResolved {
		rows, err := s.readQ.ListAllInboxByScope(ctx, scope)
		if err != nil {
			return nil, err
		}
		out := make([]contract.InboxItemView, 0, len(rows))
		for _, r := range rows {
			out = append(out, toInboxItemView(r.ID, r.Kind, r.Title, r.Summary, r.SessionID, r.IssueID, r.Resolved, r.CreatedAtMs))
		}
		return out, nil
	}

	rows, err := s.readQ.ListUnresolvedInboxByScope(ctx, scope)
	if err != nil {
		return nil, err
	}
	out := make([]contract.InboxItemView, 0, len(rows))
	for _, r := range rows {
		out = append(out, toInboxItemView(r.ID, r.Kind, r.Title, r.Summary, r.SessionID, r.IssueID, r.Resolved, r.CreatedAtMs))
	}
	return out, nil
}

func toInboxItemView(id, kind, title, summary, sessionID, issueID string, resolved, createdAtMs int64) contract.InboxItemView {
	return contract.InboxItemView{
		ID:          id,
		Kind:        contract.InboxItemKind(kind),
		Title:       title,
		Summary:     summary,
		SessionID:   sessionID,
		IssueID:     issueID,
		Resolved:    resolved != 0,
		CreatedAtMs: createdAtMs,
	}
}

type headRow struct {
	activeVersion int64
	nextVersion   int64
}

func ensureHeadTx(ctx context.Context, q *dbgen.Queries, scope string, nowMs int64) (headRow, error) {
	if err := q.EnsureHead(ctx, dbgen.EnsureHeadParams{
		ScopeID:     scope,
		UpdatedAtMs: nowMs,
	}); err != nil {
		return headRow{}, err
	}
	row, err := q.GetHead(ctx, scope)
	if err != nil {
		return headRow{}, err
	}
	return headRow{
		activeVersion: row.ActiveVersion,
		nextVersion:   row.NextVersion,
	}, nil
}

func (s *Store) loadActiveSnapshotLocked(ctx context.Context, q *dbgen.Queries, scope string) (Snapshot, error) {
	activeVer, err := q.GetActiveVersion(ctx, scope)
	if errors.Is(err, sql.ErrNoRows) || activeVer == 0 {
		return Snapshot{ScopeID: scope, Version: 0, Status: VersionStatusActive}, nil
	}
	if err != nil {
		return Snapshot{}, err
	}
	return s.loadVersionLocked(ctx, q, scope, activeVer)
}

func (s *Store) loadVersionLocked(ctx context.Context, q *dbgen.Queries, scope string, version int64) (Snapshot, error) {
	v, err := q.GetVersion(ctx, dbgen.GetVersionParams{
		ScopeID: scope,
		Version: version,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	if err != nil {
		return Snapshot{}, err
	}
	files, err := loadVersionFiles(ctx, q, scope, version)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		ScopeID:       v.ScopeID,
		Version:       v.Version,
		ParentVersion: v.ParentVersion,
		Kind:          VersionKind(v.Kind),
		Status:        VersionStatus(v.Status),
		Summary:       v.Summary,
		SessionID:     v.SessionID,
		CreatedAtMs:   v.CreatedAtMs,
		Files:         files,
	}, nil
}

func loadVersionFiles(ctx context.Context, q *dbgen.Queries, scope string, version int64) ([]MemoryFile, error) {
	rows, err := q.ListVersionFiles(ctx, dbgen.ListVersionFilesParams{
		ScopeID: scope,
		Version: version,
	})
	if err != nil {
		return nil, err
	}
	files := make([]MemoryFile, 0, len(rows))
	for _, r := range rows {
		files = append(files, MemoryFile{
			RelPath:     r.RelPath,
			Version:     r.FileVersion,
			SHA256:      r.Sha256,
			Content:     cloneBytes(r.Content),
			UpdatedAtMs: r.UpdatedAtMs,
		})
	}
	return files, nil
}

func loadActiveFileMapTx(ctx context.Context, q *dbgen.Queries, scope string, activeVersion int64) (map[string]MemoryFile, error) {
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
	q *dbgen.Queries,
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
		if err := q.UpdateVersionStatus(ctx, dbgen.UpdateVersionStatusParams{
			Status:  string(VersionStatusSuperseded),
			ScopeID: scope,
			Version: head.activeVersion,
		}); err != nil {
			return Snapshot{}, err
		}
	}

	if err := q.InsertVersion(ctx, dbgen.InsertVersionParams{
		ScopeID:       scope,
		Version:       newVer,
		ParentVersion: head.activeVersion,
		Kind:          string(kind),
		Status:        string(VersionStatusActive),
		Summary:       summary,
		SessionID:     sessionID,
		CreatedAtMs:   nowMs,
	}); err != nil {
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
		if err := q.InsertVersionFile(ctx, dbgen.InsertVersionFileParams{
			ScopeID:     scope,
			Version:     newVer,
			RelPath:     f.RelPath,
			FileVersion: f.Version,
			Sha256:      f.SHA256,
			Content:     f.Content,
			UpdatedAtMs: f.UpdatedAtMs,
		}); err != nil {
			return Snapshot{}, err
		}
		sliceFiles = append(sliceFiles, cloneMemoryFile(f))
	}

	if err := q.UpdateHeadVersions(ctx, dbgen.UpdateHeadVersionsParams{
		ActiveVersion: newVer,
		NextVersion:   newVer + 1,
		UpdatedAtMs:   nowMs,
		ScopeID:       scope,
	}); err != nil {
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
