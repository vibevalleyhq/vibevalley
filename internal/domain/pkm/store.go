package pkm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/viant/sqlite-vec/engine"
	"github.com/viant/sqlite-vec/vec"
	"github.com/viant/sqlite-vec/vector"
	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	vecTableName  = "pkm_vectors"
	vecShadowName = "main._vec_" + vecTableName

	defaultSearchLimit = 20
	defaultRRFK        = 60.0
)

var (
	registerVecFuncsOnce sync.Once
	nextMemDatasetSeq    atomic.Int64
)

var schemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS pkm_notes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		rel_path TEXT NOT NULL UNIQUE,
		slug TEXT NOT NULL,
		title TEXT NOT NULL,
		tier TEXT NOT NULL,
		sha256 TEXT NOT NULL,
		frontmatter_json TEXT NOT NULL DEFAULT '{}',
		tags_json TEXT NOT NULL DEFAULT '[]',
		body TEXT NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS pkm_notes_slug_idx ON pkm_notes(slug)`,
	`CREATE INDEX IF NOT EXISTS pkm_notes_tier_idx ON pkm_notes(tier)`,

	`CREATE TABLE IF NOT EXISTS pkm_aliases (
		alias_slug TEXT NOT NULL,
		rel_path TEXT NOT NULL,
		PRIMARY KEY(alias_slug, rel_path)
	)`,
	`CREATE INDEX IF NOT EXISTS pkm_aliases_path_idx ON pkm_aliases(rel_path)`,

	`CREATE TABLE IF NOT EXISTS pkm_blocks (
		block_id TEXT PRIMARY KEY,
		rel_path TEXT NOT NULL,
		page_title TEXT NOT NULL,
		line INTEGER NOT NULL,
		byte_start INTEGER NOT NULL,
		byte_end INTEGER NOT NULL,
		body TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS pkm_blocks_path_idx ON pkm_blocks(rel_path)`,

	`CREATE TABLE IF NOT EXISTS pkm_links (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		source_path TEXT NOT NULL,
		kind TEXT NOT NULL,
		target_title TEXT NOT NULL,
		target_slug TEXT NOT NULL,
		block_id TEXT NOT NULL DEFAULT '',
		source_block_id TEXT NOT NULL DEFAULT '',
		line INTEGER NOT NULL,
		byte_start INTEGER NOT NULL,
		byte_end INTEGER NOT NULL,
		snippet TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS pkm_links_source_idx ON pkm_links(source_path)`,
	`CREATE INDEX IF NOT EXISTS pkm_links_target_idx ON pkm_links(target_slug)`,
	`CREATE INDEX IF NOT EXISTS pkm_links_block_idx ON pkm_links(block_id)`,

	`CREATE VIRTUAL TABLE IF NOT EXISTS pkm_notes_fts USING fts5(
		rel_path UNINDEXED,
		title,
		tags,
		body,
		tokenize='trigram'
	)`,

	`CREATE TABLE IF NOT EXISTS vector_storage (
		shadow_table_name TEXT NOT NULL,
		dataset_id TEXT NOT NULL DEFAULT '',
		"index" BLOB,
		PRIMARY KEY (shadow_table_name, dataset_id)
	)`,

	`CREATE TABLE IF NOT EXISTS _vec_` + vecTableName + ` (
		dataset_id TEXT NOT NULL,
		id TEXT NOT NULL,
		content TEXT,
		meta TEXT,
		embedding BLOB,
		PRIMARY KEY(dataset_id, id)
	)`,

	`CREATE VIRTUAL TABLE IF NOT EXISTS ` + vecTableName + ` USING vec(doc_id)`,
}

// StoreOption configures a PKM SQLite store.
type StoreOption func(*storeConfig)

type storeConfig struct {
	datasetID string
}

// WithDatasetID overrides the sqlite-vec dataset identifier used by Store.
func WithDatasetID(datasetID string) StoreOption {
	return func(c *storeConfig) {
		if strings.TrimSpace(datasetID) != "" {
			c.datasetID = strings.TrimSpace(datasetID)
		}
	}
}

// Store is the SSOT backend for PARA Markdown parsing, forward/backlinks graph queries,
// FTS5 trigram search, and sqlite-vec cosine hybrid recall.
type Store struct {
	writeDB   *sql.DB
	readDB    *sql.DB
	sameDB    bool
	isMem     bool
	datasetID string

	mu     sync.Mutex
	closed atomic.Bool
}

// OpenStore opens or creates a SQLite-backed PKM Store with FTS5 trigram and sqlite-vec enabled.
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

	var cfg storeConfig
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}

	registerVecFuncsOnce.Do(func() {
		_ = engine.RegisterVectorFunctions(nil)
	})

	isMem := dsn == ":memory:" || strings.Contains(dsn, "mode=memory") || strings.Contains(dsn, ":memory:")
	if cfg.datasetID == "" {
		if isMem {
			cfg.datasetID = fmt.Sprintf("pkm-mem-%d", nextMemDatasetSeq.Add(1))
		} else {
			cfg.datasetID = "pkm"
		}
	}

	writeDB, err := engine.Open(dsn)
	if err != nil {
		return nil, fmt.Errorf("pkm: open sqlite writer: %w", err)
	}
	writeDB.SetMaxOpenConns(1)

	if err := vec.Register(writeDB); err != nil {
		_ = writeDB.Close()
		return nil, fmt.Errorf("pkm: register sqlite-vec: %w", err)
	}

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
			return nil, fmt.Errorf("pkm: %s: %w", p, err)
		}
	}

	for _, ddl := range schemaDDL {
		if _, err := writeDB.ExecContext(ctx, ddl); err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("pkm: apply schema: %w", err)
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
		readDB, err = engine.Open(readDSN)
		if err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("pkm: open sqlite reader: %w", err)
		}
		readDB.SetMaxOpenConns(4)
	}

	return &Store{
		writeDB:   writeDB,
		readDB:    readDB,
		sameDB:    sameDB,
		isMem:     isMem,
		datasetID: cfg.datasetID,
	}, nil
}

// Close releases SQLite connections and invalidates cached sqlite-vec indices.
func (s *Store) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	vec.InvalidateCache(vecShadowName, s.datasetID)
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

// DB exposes the underlying read *sql.DB handle for diagnostics and schema inspection.
func (s *Store) DB() *sql.DB {
	return s.readDB
}

// UpsertNote parses and indexes a single note along with its optional embedding vector.
func (s *Store) UpsertNote(ctx context.Context, input NoteInput) (Note, error) {
	notes, err := s.IndexBatch(ctx, []NoteInput{input})
	if err != nil {
		return Note{}, err
	}
	if len(notes) == 0 {
		return Note{}, ErrInvalidArgument
	}
	return notes[0], nil
}

// IndexBatch concurrently parses a batch of notes with Goldmark and commits all AST links,
// FTS5 trigram entries, and vector embeddings in a single SQLite transaction.
func (s *Store) IndexBatch(ctx context.Context, inputs []NoteInput) ([]Note, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	if len(inputs) == 0 {
		return nil, nil
	}

	notes, err := parseInputsParallel(ctx, inputs)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	existingIDs, err := loadExistingNoteIDs(ctx, tx)
	if err != nil {
		return nil, err
	}

	stmts, err := prepareBatchStmts(ctx, tx)
	if err != nil {
		return nil, err
	}
	defer stmts.close()

	wroteVectors := false
	pendingBlocks := make([]pendingBlockRow, 0, len(notes))
	pendingLinks := make([]pendingLinkRow, 0, len(notes)*2)

	for i, note := range notes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		noteID, exists := existingIDs[note.RelPath]
		if exists {
			if err := deleteNoteDetails(ctx, stmts, note.RelPath, noteID); err != nil {
				return nil, err
			}
		}

		fmJSON, err := json.Marshal(note.Frontmatter)
		if err != nil {
			return nil, err
		}
		tagsJSON, err := json.Marshal(note.Tags)
		if err != nil {
			return nil, err
		}

		var assignedID int64
		if exists {
			if _, err := stmts.updateNote.ExecContext(ctx,
				note.Slug, note.Title, string(note.Tier), note.SHA256,
				string(fmJSON), string(tagsJSON), note.Body, note.UpdatedAtMs, noteID,
			); err != nil {
				return nil, err
			}
			assignedID = noteID
		} else {
			res, err := stmts.insertNote.ExecContext(ctx,
				note.RelPath, note.Slug, note.Title, string(note.Tier), note.SHA256,
				string(fmJSON), string(tagsJSON), note.Body, note.UpdatedAtMs,
			)
			if err != nil {
				return nil, err
			}
			assignedID, err = res.LastInsertId()
			if err != nil {
				return nil, err
			}
			existingIDs[note.RelPath] = assignedID
		}

		for _, alias := range note.Frontmatter.Aliases {
			if aliasSlug := SlugOf(alias); aliasSlug != "" {
				if _, err := stmts.insertAlias.ExecContext(ctx, aliasSlug, note.RelPath); err != nil {
					return nil, err
				}
			}
		}

		for _, blk := range note.Blocks {
			pendingBlocks = append(pendingBlocks, pendingBlockRow{
				blockID:   blk.ID,
				relPath:   note.RelPath,
				pageTitle: note.Title,
				line:      blk.Line,
				byteStart: blk.ByteStart,
				byteEnd:   blk.ByteEnd,
				body:      blk.Body,
			})
		}

		for _, link := range note.Links {
			pendingLinks = append(pendingLinks, pendingLinkRow{
				sourcePath:    link.Backlink.SourcePath,
				kind:          string(link.Kind),
				targetTitle:   link.Backlink.TargetTitle,
				targetSlug:    link.TargetSlug,
				blockID:       link.Backlink.BlockID,
				sourceBlockID: link.SourceBlockID,
				line:          link.Backlink.Line,
				byteStart:     link.Backlink.ByteStart,
				byteEnd:       link.Backlink.ByteEnd,
				snippet:       link.Backlink.Snippet,
			})
		}

		ftsTitle := strings.TrimSpace(strings.Join(append([]string{note.Title}, note.Frontmatter.Aliases...), " "))
		ftsTags := strings.Join(note.Tags, " ")
		ftsBody := note.Body
		if note.Frontmatter.TLDR != "" {
			ftsBody = note.Frontmatter.TLDR + "\n" + ftsBody
		}
		if _, err := stmts.insertFTS.ExecContext(ctx, assignedID, note.RelPath, ftsTitle, ftsTags, ftsBody); err != nil {
			return nil, err
		}

		if len(inputs[i].Embedding) > 0 {
			blob, err := vector.EncodeEmbedding(inputs[i].Embedding)
			if err != nil {
				return nil, err
			}
			metaJSON, err := json.Marshal(map[string]string{
				"title": note.Title,
				"tier":  string(note.Tier),
			})
			if err != nil {
				return nil, err
			}
			if _, err := stmts.upsertVec.ExecContext(ctx, s.datasetID, note.RelPath, note.Title, string(metaJSON), blob); err != nil {
				return nil, err
			}
			wroteVectors = true
		} else if exists {
			res, err := stmts.deleteVec.ExecContext(ctx, s.datasetID, note.RelPath)
			if err != nil {
				return nil, err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				wroteVectors = true
			}
		}
	}

	if err := flushBlockRows(ctx, tx, pendingBlocks); err != nil {
		return nil, err
	}
	if err := flushLinkRows(ctx, tx, pendingLinks); err != nil {
		return nil, err
	}

	if wroteVectors {
		if _, err := tx.ExecContext(ctx, `DELETE FROM vector_storage WHERE shadow_table_name = ? AND dataset_id = ?`, vecShadowName, s.datasetID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if wroteVectors {
		vec.InvalidateCache(vecShadowName, s.datasetID)
	}
	return notes, nil
}

// SyncDir parses rootDir and incrementally synchronizes new, modified, and deleted Markdown notes.
func (s *Store) SyncDir(ctx context.Context, rootDir string, embedder Embedder) (SyncStats, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return SyncStats{}, ErrClosed
	}

	parsed, err := ParseVaultDir(ctx, rootDir)
	if err != nil {
		return SyncStats{}, err
	}

	existingSHAs, err := s.noteSHAs(ctx)
	if err != nil {
		return SyncStats{}, err
	}

	diskSeen := make(map[string]bool, len(parsed))
	var toIndex []NoteInput
	var stats SyncStats

	for _, n := range parsed {
		diskSeen[n.RelPath] = true
		if oldSHA, ok := existingSHAs[n.RelPath]; ok && oldSHA == n.SHA256 {
			stats.Unchanged++
			continue
		}
		var emb []float32
		if embedder != nil {
			emb, err = embedder.Embed(n.Title + "\n" + n.Body)
			if err != nil {
				return stats, err
			}
		}
		toIndex = append(toIndex, NoteInput{
			RelPath:     n.RelPath,
			Content:     n.Source,
			Embedding:   emb,
			UpdatedAtMs: n.UpdatedAtMs,
		})
	}

	if len(toIndex) > 0 {
		if _, err := s.IndexBatch(ctx, toIndex); err != nil {
			return stats, err
		}
		stats.Indexed = len(toIndex)
	}

	for relPath := range existingSHAs {
		if !diskSeen[relPath] {
			if err := s.DeleteNote(ctx, relPath); err != nil {
				return stats, err
			}
			stats.Deleted++
		}
	}
	return stats, nil
}

// DeleteNote removes a note and all derived links, blocks, FTS entries, and vector rows.
func (s *Store) DeleteNote(ctx context.Context, relPath string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return ErrClosed
	}
	clean := normalizeRelSlash(relPath)
	if clean == "" {
		return fmt.Errorf("%w: %q", ErrInvalidPath, relPath)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var noteID int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM pkm_notes WHERE rel_path = ?`, clean).Scan(&noteID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM pkm_aliases WHERE rel_path = ?`, []any{clean}},
		{`DELETE FROM pkm_blocks WHERE rel_path = ?`, []any{clean}},
		{`DELETE FROM pkm_links WHERE source_path = ?`, []any{clean}},
		{`DELETE FROM pkm_notes_fts WHERE rowid = ?`, []any{noteID}},
		{`DELETE FROM _vec_` + vecTableName + ` WHERE dataset_id = ? AND id = ?`, []any{s.datasetID, clean}},
		{`DELETE FROM vector_storage WHERE shadow_table_name = ? AND dataset_id = ?`, []any{vecShadowName, s.datasetID}},
		{`DELETE FROM pkm_notes WHERE id = ?`, []any{noteID}},
	} {
		if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	vec.InvalidateCache(vecShadowName, s.datasetID)
	return nil
}

// GetNote retrieves an indexed note by relative path, slug, or title.
func (s *Store) GetNote(ctx context.Context, pathOrRef string) (Note, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return Note{}, false, ErrClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	clean := normalizeRelSlash(pathOrRef)
	slug := SlugOf(pathOrRef)
	row := s.readDB.QueryRowContext(ctx, `
		SELECT rel_path, slug, title, tier, sha256, frontmatter_json, tags_json, body, updated_at_ms
		FROM pkm_notes
		WHERE rel_path = ? OR slug = ? OR lower(title) = lower(?)
		LIMIT 1`, clean, slug, strings.TrimSpace(pathOrRef),
	)
	var n Note
	var tierStr, fmJSON, tagsJSON string
	err := row.Scan(&n.RelPath, &n.Slug, &n.Title, &tierStr, &n.SHA256, &fmJSON, &tagsJSON, &n.Body, &n.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, false, nil
	}
	if err != nil {
		return Note{}, false, err
	}
	n.Tier = Tier(tierStr)
	if err := json.Unmarshal([]byte(fmJSON), &n.Frontmatter); err != nil {
		return Note{}, false, err
	}
	if err := json.Unmarshal([]byte(tagsJSON), &n.Tags); err != nil {
		return Note{}, false, err
	}

	links, err := s.queryForwardLinksLocked(ctx, n.RelPath)
	if err != nil {
		return Note{}, false, err
	}
	n.Links = links

	blocks, err := s.queryBlocksForPathLocked(ctx, n.RelPath)
	if err != nil {
		return Note{}, false, err
	}
	n.Blocks = blocks
	return n, true, nil
}

// ForwardLinks returns the SSOT outgoing link spans for sourcePath as contract.BacklinkView items.
func (s *Store) ForwardLinks(ctx context.Context, sourcePath string) ([]contract.BacklinkView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	clean := normalizeRelSlash(sourcePath)
	if clean == "" {
		return nil, fmt.Errorf("%w: %q", ErrInvalidPath, sourcePath)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	spans, err := s.queryForwardLinksLocked(ctx, clean)
	if err != nil {
		return nil, err
	}
	out := make([]contract.BacklinkView, len(spans))
	for i, sp := range spans {
		out[i] = sp.Backlink
	}
	return out, nil
}

// Backlinks returns all SSOT backlinks pointing to target (by page title, path, slug, or alias),
// including WikiLinks, embeds, and resolved block references targeting blocks on that page.
func (s *Store) Backlinks(ctx context.Context, target string) ([]contract.BacklinkView, error) {
	return s.queryBacklinks(ctx, target, "")
}

// BacklinksByKind returns SSOT backlinks pointing to target filtered by LinkKind.
func (s *Store) BacklinksByKind(ctx context.Context, target string, kind LinkKind) ([]contract.BacklinkView, error) {
	return s.queryBacklinks(ctx, target, kind)
}

// BlockBacklinks returns all backlink spans referencing a specific block ID (`((blockID))` or `![[((blockID))]]`).
func (s *Store) BlockBacklinks(ctx context.Context, blockID string) ([]contract.BacklinkView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	bid := strings.TrimSpace(blockID)
	if bid == "" {
		return nil, fmt.Errorf("%w: empty blockID", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.readDB.QueryContext(ctx, `
		SELECT l.source_path,
		       COALESCE(NULLIF(l.target_title, ''), b.page_title, ''),
		       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
		FROM pkm_links l
		LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
		WHERE l.block_id = ?
		ORDER BY l.source_path ASC, l.byte_start ASC`, bid,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBacklinkViews(rows)
}

// TagBacklinks returns all backlink spans referencing #tag (with or without leading '#').
func (s *Store) TagBacklinks(ctx context.Context, tag string) ([]contract.BacklinkView, error) {
	clean := strings.TrimSpace(strings.TrimPrefix(tag, "#"))
	if clean == "" {
		return nil, fmt.Errorf("%w: empty tag", ErrInvalidArgument)
	}
	return s.queryBacklinks(ctx, clean, KindTag)
}

// ResolveBlock looks up an indexed `id:: <blockID>` block definition and its owning note path.
func (s *Store) ResolveBlock(ctx context.Context, blockID string) (BlockDef, string, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return BlockDef{}, "", false, ErrClosed
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	var bd BlockDef
	var relPath string
	err := s.readDB.QueryRowContext(ctx, `
		SELECT block_id, rel_path, body, line, byte_start, byte_end
		FROM pkm_blocks
		WHERE block_id = ?`, strings.TrimSpace(blockID),
	).Scan(&bd.ID, &relPath, &bd.Body, &bd.Line, &bd.ByteStart, &bd.ByteEnd)
	if errors.Is(err, sql.ErrNoRows) {
		return BlockDef{}, "", false, nil
	}
	if err != nil {
		return BlockDef{}, "", false, err
	}
	return bd, relPath, true, nil
}

// Search executes hybrid search combining SQLite FTS5 trigram matching, sqlite-vec cosine recall,
// weighted Reciprocal Rank Fusion (RRF), and PARA tier weighting.
func (s *Store) Search(ctx context.Context, q SearchQuery) ([]SearchHit, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}

	limit := q.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	ftsWeight := q.FTSWeight
	if ftsWeight <= 0 {
		ftsWeight = 1.0
	}
	vecWeight := q.VectorWeight
	if vecWeight <= 0 {
		vecWeight = 1.0
	}
	rrfK := q.RRFK
	if rrfK <= 0 {
		rrfK = defaultRRFK
	}
	candidateLimit := max(limit*6, 120)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}

	trimmedText := strings.TrimSpace(q.Text)
	hasText := trimmedText != ""
	hasVec := len(q.QueryVector) > 0

	if !hasText && !hasVec {
		return s.listFilteredHitsLocked(ctx, q, limit)
	}

	type candScore struct {
		ftsScore float64
		ftsRank  int
		vecScore float64
		vecRank  int
	}
	candidates := make(map[string]*candScore)
	getCand := func(relPath string) *candScore {
		c := candidates[relPath]
		if c == nil {
			c = &candScore{}
			candidates[relPath] = c
		}
		return c
	}

	if hasText {
		ftsHits, err := s.searchFTS5TrigramLocked(ctx, trimmedText, candidateLimit)
		if err != nil {
			return nil, err
		}
		for i, h := range ftsHits {
			c := getCand(h.relPath)
			c.ftsScore = h.score
			c.ftsRank = i + 1
		}
	}

	if hasVec {
		vecMatches, err := vec.Search(ctx, s.readDB, vecTableName, s.datasetID, q.QueryVector)
		if err != nil {
			return nil, fmt.Errorf("pkm: vector search: %w", err)
		}
		rank := 0
		for _, m := range vecMatches {
			if hasText && m.Score <= 0 {
				continue
			}
			rank++
			if rank > candidateLimit {
				break
			}
			c := getCand(m.ID)
			c.vecScore = m.Score
			c.vecRank = rank
		}
	}

	if len(candidates) == 0 {
		return nil, nil
	}

	linkedPaths, err := s.filterLinkedPathsLocked(ctx, q.LinkedTo)
	if err != nil {
		return nil, err
	}

	paths := make([]string, 0, len(candidates))
	for p := range candidates {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	metaByPath, err := s.loadSearchMetaLocked(ctx, paths)
	if err != nil {
		return nil, err
	}
	backlinkCounts, err := s.loadBacklinkCountsLocked(ctx)
	if err != nil {
		return nil, err
	}

	var hits []SearchHit
	cleanTag := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(q.Tag, "#")))
	for _, relPath := range paths {
		meta, ok := metaByPath[relPath]
		if !ok {
			continue
		}
		if q.Tier != "" && meta.tier != q.Tier {
			continue
		}
		if cleanTag != "" && !containsTagFold(meta.tags, cleanTag) {
			continue
		}
		if linkedPaths != nil && !linkedPaths[relPath] {
			continue
		}

		c := candidates[relPath]
		var rrf float64
		if c.ftsRank > 0 {
			rrf += ftsWeight / (rrfK + float64(c.ftsRank))
		}
		if c.vecRank > 0 {
			rrf += vecWeight / (rrfK + float64(c.vecRank))
		}
		finalScore := rrf * TierWeight(meta.tier)

		hits = append(hits, SearchHit{
			RelPath:       relPath,
			Title:         meta.title,
			Slug:          meta.slug,
			Tier:          meta.tier,
			Score:         finalScore,
			FTSScore:      c.ftsScore,
			FTSRank:       c.ftsRank,
			VectorScore:   c.vecScore,
			VectorRank:    c.vecRank,
			Snippet:       extractSnippet(meta.body, trimmedText),
			Tags:          meta.tags,
			BacklinkCount: backlinkCounts[meta.slug],
		})
	}

	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if hits[i].VectorScore != hits[j].VectorScore {
			return hits[i].VectorScore > hits[j].VectorScore
		}
		if hits[i].FTSScore != hits[j].FTSScore {
			return hits[i].FTSScore > hits[j].FTSScore
		}
		return hits[i].RelPath < hits[j].RelPath
	})

	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

type ftsCandidate struct {
	relPath string
	score   float64
}

func (s *Store) searchFTS5TrigramLocked(ctx context.Context, queryText string, limit int) ([]ftsCandidate, error) {
	terms := strings.Fields(queryText)
	var trigramTerms []string
	var shortTerms []string
	for _, term := range terms {
		if utf8.RuneCountInString(term) >= 3 {
			trigramTerms = append(trigramTerms, term)
		} else if term != "" {
			shortTerms = append(shortTerms, term)
		}
	}

	scores := make(map[string]float64)

	// Full phrase FTS5 trigram MATCH boost when the complete query is at least 3 runes.
	if utf8.RuneCountInString(queryText) >= 3 {
		expr := ftsPhraseQuote(queryText)
		rows, err := s.readDB.QueryContext(ctx, `
			SELECT rel_path, -bm25(pkm_notes_fts, 4.0, 2.0, 1.0) AS rank_score
			FROM pkm_notes_fts
			WHERE pkm_notes_fts MATCH ?
			ORDER BY rank_score DESC
			LIMIT ?`, expr, limit,
		)
		if err != nil {
			return nil, fmt.Errorf("pkm: fts5 trigram phrase search: %w", err)
		}
		for rows.Next() {
			var p string
			var sc float64
			if err := rows.Scan(&p, &sc); err != nil {
				_ = rows.Close()
				return nil, err
			}
			// Exact phrase matches get a +5.0 bonus over split-term OR matches.
			if cur := sc + 5.0; cur > scores[p] {
				scores[p] = cur
			}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	if len(trigramTerms) > 0 && (len(trigramTerms) > 1 || len(scores) < limit) {
		var quoted []string
		for _, t := range trigramTerms {
			quoted = append(quoted, ftsPhraseQuote(t))
		}
		expr := strings.Join(quoted, " OR ")
		rows, err := s.readDB.QueryContext(ctx, `
			SELECT rel_path, -bm25(pkm_notes_fts, 4.0, 2.0, 1.0) AS rank_score
			FROM pkm_notes_fts
			WHERE pkm_notes_fts MATCH ?
			ORDER BY rank_score DESC
			LIMIT ?`, expr, limit,
		)
		if err != nil {
			return nil, fmt.Errorf("pkm: fts5 trigram term search: %w", err)
		}
		for rows.Next() {
			var p string
			var sc float64
			if err := rows.Scan(&p, &sc); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if _, ok := scores[p]; !ok {
				scores[p] = sc
			}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	// Short (<3 rune) CJK/English tokens cannot form a 3-rune trigram in FTS5 MATCH;
	// supplement with exact substring matching via INSTR so 1-2 char queries work seamlessly.
	for _, st := range shortTerms {
		lower := strings.ToLower(st)
		rows, err := s.readDB.QueryContext(ctx, `
			SELECT rel_path,
			       (CASE WHEN INSTR(lower(title), ?) > 0 THEN 4.0 ELSE 0.0 END) +
			       (CASE WHEN INSTR(lower(tags_json), ?) > 0 THEN 2.0 ELSE 0.0 END) +
			       (CASE WHEN INSTR(lower(body), ?) > 0 THEN 1.0 ELSE 0.0 END) AS s
			FROM pkm_notes
			WHERE INSTR(lower(title), ?) > 0 OR INSTR(lower(tags_json), ?) > 0 OR INSTR(lower(body), ?) > 0
			ORDER BY s DESC
			LIMIT ?`, lower, lower, lower, lower, lower, lower, limit,
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var p string
			var sc float64
			if err := rows.Scan(&p, &sc); err != nil {
				_ = rows.Close()
				return nil, err
			}
			scores[p] += sc
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	if len(scores) == 0 {
		return nil, nil
	}
	out := make([]ftsCandidate, 0, len(scores))
	for p, sc := range scores {
		out = append(out, ftsCandidate{relPath: p, score: sc})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].relPath < out[j].relPath
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func ftsPhraseQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func (s *Store) queryBacklinks(ctx context.Context, target string, kind LinkKind) ([]contract.BacklinkView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return nil, fmt.Errorf("%w: empty target", ErrInvalidArgument)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	targetSlugs, targetPaths, err := s.resolveTargetIdentitiesLocked(ctx, trimmed)
	if err != nil {
		return nil, err
	}

	slugPlaceholders, slugArgs := inClause(targetSlugs)
	args := make([]any, 0, len(slugArgs)+len(targetPaths)+2)
	args = append(args, slugArgs...)

	var query strings.Builder
	query.WriteString(`
		SELECT l.source_path,
		       COALESCE(NULLIF(l.target_title, ''), b.page_title, ''),
		       l.block_id, l.line, l.byte_start, l.byte_end, l.snippet
		FROM pkm_links l
		LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
		WHERE (`)
	query.WriteString(`l.target_slug IN (` + slugPlaceholders + `)`)
	if len(targetPaths) > 0 && kind != KindTag {
		pathPlaceholders, pathArgs := inClause(targetPaths)
		query.WriteString(` OR (l.block_id <> '' AND b.rel_path IN (` + pathPlaceholders + `))`)
		args = append(args, pathArgs...)
	}
	query.WriteString(`)`)
	if kind != "" {
		query.WriteString(` AND l.kind = ?`)
		args = append(args, string(kind))
	}
	query.WriteString(` ORDER BY l.source_path ASC, l.byte_start ASC`)

	rows, err := s.readDB.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBacklinkViews(rows)
}

func (s *Store) resolveTargetIdentitiesLocked(ctx context.Context, rawTarget string) (slugs []string, relPaths []string, err error) {
	slugSet := make(map[string]struct{})
	pathSet := make(map[string]struct{})

	cleanNoHash := strings.TrimSpace(strings.TrimPrefix(rawTarget, "#"))
	if sl := SlugOf(cleanNoHash); sl != "" {
		slugSet[sl] = struct{}{}
	}
	if cleanPath := normalizeRelSlash(rawTarget); cleanPath != "" {
		if sl := SlugOf(TitleOfPath(cleanPath)); sl != "" {
			slugSet[sl] = struct{}{}
		}
	}

	seedSlugs := make([]string, 0, len(slugSet))
	for sl := range slugSet {
		seedSlugs = append(seedSlugs, sl)
	}
	sort.Strings(seedSlugs)

	if len(seedSlugs) > 0 {
		ph, args := inClause(seedSlugs)
		args = append(args, normalizeRelSlash(rawTarget))
		rows, err := s.readDB.QueryContext(ctx, `
			SELECT rel_path, slug FROM pkm_notes
			WHERE slug IN (`+ph+`) OR rel_path = ?`, args...,
		)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var p, sl string
			if err := rows.Scan(&p, &sl); err != nil {
				_ = rows.Close()
				return nil, nil, err
			}
			pathSet[p] = struct{}{}
			if sl != "" {
				slugSet[sl] = struct{}{}
			}
		}
		if err := rows.Close(); err != nil {
			return nil, nil, err
		}

		// Also match pages whose alias matches the requested target.
		ph2, args2 := inClause(seedSlugs)
		aliasRows, err := s.readDB.QueryContext(ctx, `
			SELECT a.rel_path, n.slug
			FROM pkm_aliases a
			JOIN pkm_notes n ON n.rel_path = a.rel_path
			WHERE a.alias_slug IN (`+ph2+`)`, args2...,
		)
		if err != nil {
			return nil, nil, err
		}
		for aliasRows.Next() {
			var p, sl string
			if err := aliasRows.Scan(&p, &sl); err != nil {
				_ = aliasRows.Close()
				return nil, nil, err
			}
			pathSet[p] = struct{}{}
			if sl != "" {
				slugSet[sl] = struct{}{}
			}
		}
		if err := aliasRows.Close(); err != nil {
			return nil, nil, err
		}
	}

	// Include aliases of any resolved page so links via alias also appear in backlinks.
	if len(pathSet) > 0 {
		paths := make([]string, 0, len(pathSet))
		for p := range pathSet {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		ph, args := inClause(paths)
		rows, err := s.readDB.QueryContext(ctx, `
			SELECT alias_slug FROM pkm_aliases WHERE rel_path IN (`+ph+`)`, args...,
		)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var as string
			if err := rows.Scan(&as); err != nil {
				_ = rows.Close()
				return nil, nil, err
			}
			if as != "" {
				slugSet[as] = struct{}{}
			}
		}
		if err := rows.Close(); err != nil {
			return nil, nil, err
		}
	}

	slugs = make([]string, 0, len(slugSet))
	for sl := range slugSet {
		slugs = append(slugs, sl)
	}
	sort.Strings(slugs)

	relPaths = make([]string, 0, len(pathSet))
	for p := range pathSet {
		relPaths = append(relPaths, p)
	}
	sort.Strings(relPaths)
	return slugs, relPaths, nil
}

func (s *Store) queryForwardLinksLocked(ctx context.Context, sourcePath string) ([]LinkSpan, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT l.kind,
		       COALESCE(NULLIF(l.target_title, ''), b.page_title, ''),
		       l.target_slug,
		       l.block_id,
		       l.source_block_id,
		       l.line,
		       l.byte_start,
		       l.byte_end,
		       l.snippet
		FROM pkm_links l
		LEFT JOIN pkm_blocks b ON b.block_id = l.block_id
		WHERE l.source_path = ?
		ORDER BY l.byte_start ASC`, sourcePath,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []LinkSpan
	for rows.Next() {
		var kindStr, targetTitle, targetSlug, blockID, srcBlockID, snippet string
		var line, byteStart, byteEnd int
		if err := rows.Scan(&kindStr, &targetTitle, &targetSlug, &blockID, &srcBlockID, &line, &byteStart, &byteEnd, &snippet); err != nil {
			return nil, err
		}
		out = append(out, LinkSpan{
			Kind:          LinkKind(kindStr),
			TargetSlug:    targetSlug,
			SourceBlockID: srcBlockID,
			Backlink: contract.BacklinkView{
				SourcePath:  sourcePath,
				TargetTitle: targetTitle,
				BlockID:     blockID,
				Line:        line,
				ByteStart:   byteStart,
				ByteEnd:     byteEnd,
				Snippet:     snippet,
			},
		})
	}
	return out, rows.Err()
}

func (s *Store) queryBlocksForPathLocked(ctx context.Context, relPath string) ([]BlockDef, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT block_id, body, line, byte_start, byte_end
		FROM pkm_blocks
		WHERE rel_path = ?
		ORDER BY byte_start ASC`, relPath,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []BlockDef
	for rows.Next() {
		var b BlockDef
		if err := rows.Scan(&b.ID, &b.Body, &b.Line, &b.ByteStart, &b.ByteEnd); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) noteSHAs(ctx context.Context) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.readDB.QueryContext(ctx, `SELECT rel_path, sha256 FROM pkm_notes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string)
	for rows.Next() {
		var p, sha string
		if err := rows.Scan(&p, &sha); err != nil {
			return nil, err
		}
		out[p] = sha
	}
	return out, rows.Err()
}

func (s *Store) filterLinkedPathsLocked(ctx context.Context, linkedTo string) (map[string]bool, error) {
	trimmed := strings.TrimSpace(linkedTo)
	if trimmed == "" {
		return nil, nil
	}
	slugs, paths, err := s.resolveTargetIdentitiesLocked(ctx, trimmed)
	if err != nil {
		return nil, err
	}
	if len(slugs) == 0 && len(paths) == 0 {
		return map[string]bool{}, nil
	}
	ph, args := inClause(slugs)
	var q strings.Builder
	q.WriteString(`SELECT DISTINCT l.source_path FROM pkm_links l LEFT JOIN pkm_blocks b ON b.block_id = l.block_id WHERE l.target_slug IN (` + ph + `)`)
	if len(paths) > 0 {
		ph2, args2 := inClause(paths)
		q.WriteString(` OR (l.block_id <> '' AND b.rel_path IN (` + ph2 + `))`)
		args = append(args, args2...)
	}
	rows, err := s.readDB.QueryContext(ctx, q.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]bool)
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out[p] = true
	}
	return out, rows.Err()
}

type noteSearchMeta struct {
	title string
	slug  string
	tier  Tier
	tags  []string
	body  string
}

func (s *Store) loadSearchMetaLocked(ctx context.Context, paths []string) (map[string]noteSearchMeta, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	out := make(map[string]noteSearchMeta, len(paths))
	const chunk = 500
	for start := 0; start < len(paths); start += chunk {
		end := min(start+chunk, len(paths))
		ph, args := inClause(paths[start:end])
		rows, err := s.readDB.QueryContext(ctx, `
			SELECT rel_path, title, slug, tier, tags_json, body
			FROM pkm_notes
			WHERE rel_path IN (`+ph+`)`, args...,
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var rel, title, slug, tierStr, tagsJSON, body string
			if err := rows.Scan(&rel, &title, &slug, &tierStr, &tagsJSON, &body); err != nil {
				_ = rows.Close()
				return nil, err
			}
			var tags []string
			if tagsJSON != "" {
				_ = json.Unmarshal([]byte(tagsJSON), &tags)
			}
			out[rel] = noteSearchMeta{
				title: title,
				slug:  slug,
				tier:  Tier(tierStr),
				tags:  tags,
				body:  body,
			}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Store) loadBacklinkCountsLocked(ctx context.Context) (map[string]int, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT target_slug, COUNT(*)
		FROM pkm_links
		WHERE target_slug <> ''
		GROUP BY target_slug`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int)
	for rows.Next() {
		var sl string
		var cnt int
		if err := rows.Scan(&sl, &cnt); err != nil {
			return nil, err
		}
		out[sl] = cnt
	}
	return out, rows.Err()
}

func (s *Store) listFilteredHitsLocked(ctx context.Context, q SearchQuery, limit int) ([]SearchHit, error) {
	linkedPaths, err := s.filterLinkedPathsLocked(ctx, q.LinkedTo)
	if err != nil {
		return nil, err
	}
	backlinkCounts, err := s.loadBacklinkCountsLocked(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT rel_path, title, slug, tier, tags_json, body, updated_at_ms
		FROM pkm_notes
		ORDER BY updated_at_ms DESC, rel_path ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cleanTag := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(q.Tag, "#")))
	var hits []SearchHit
	for rows.Next() {
		var rel, title, slug, tierStr, tagsJSON, body string
		var updatedAt int64
		if err := rows.Scan(&rel, &title, &slug, &tierStr, &tagsJSON, &body, &updatedAt); err != nil {
			return nil, err
		}
		tier := Tier(tierStr)
		if q.Tier != "" && tier != q.Tier {
			continue
		}
		var tags []string
		if tagsJSON != "" {
			_ = json.Unmarshal([]byte(tagsJSON), &tags)
		}
		if cleanTag != "" && !containsTagFold(tags, cleanTag) {
			continue
		}
		if linkedPaths != nil && !linkedPaths[rel] {
			continue
		}
		hits = append(hits, SearchHit{
			RelPath:       rel,
			Title:         title,
			Slug:          slug,
			Tier:          tier,
			Score:         TierWeight(tier),
			Snippet:       extractSnippet(body, ""),
			Tags:          tags,
			BacklinkCount: backlinkCounts[slug],
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].RelPath < hits[j].RelPath
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

type batchStmts struct {
	updateNote  *sql.Stmt
	insertNote  *sql.Stmt
	deleteAlias *sql.Stmt
	insertAlias *sql.Stmt
	deleteBlock *sql.Stmt
	deleteLink  *sql.Stmt
	deleteFTS   *sql.Stmt
	insertFTS   *sql.Stmt
	deleteVec   *sql.Stmt
	upsertVec   *sql.Stmt
}

type pendingBlockRow struct {
	blockID   string
	relPath   string
	pageTitle string
	line      int
	byteStart int
	byteEnd   int
	body      string
}

type pendingLinkRow struct {
	sourcePath    string
	kind          string
	targetTitle   string
	targetSlug    string
	blockID       string
	sourceBlockID string
	line          int
	byteStart     int
	byteEnd       int
	snippet       string
}

func flushBlockRows(ctx context.Context, tx *sql.Tx, rows []pendingBlockRow) error {
	const batchSize = 100
	for start := 0; start < len(rows); start += batchSize {
		end := min(start+batchSize, len(rows))
		chunk := rows[start:end]
		var q strings.Builder
		q.WriteString(`INSERT INTO pkm_blocks (block_id, rel_path, page_title, line, byte_start, byte_end, body) VALUES `)
		args := make([]any, 0, len(chunk)*7)
		for i, r := range chunk {
			if i > 0 {
				q.WriteByte(',')
			}
			q.WriteString(`(?,?,?,?,?,?,?)`)
			args = append(args, r.blockID, r.relPath, r.pageTitle, r.line, r.byteStart, r.byteEnd, r.body)
		}
		q.WriteString(` ON CONFLICT(block_id) DO UPDATE SET rel_path=excluded.rel_path, page_title=excluded.page_title, line=excluded.line, byte_start=excluded.byte_start, byte_end=excluded.byte_end, body=excluded.body`)
		if _, err := tx.ExecContext(ctx, q.String(), args...); err != nil {
			return err
		}
	}
	return nil
}

func flushLinkRows(ctx context.Context, tx *sql.Tx, rows []pendingLinkRow) error {
	const batchSize = 100
	for start := 0; start < len(rows); start += batchSize {
		end := min(start+batchSize, len(rows))
		chunk := rows[start:end]
		var q strings.Builder
		q.WriteString(`INSERT INTO pkm_links (source_path, kind, target_title, target_slug, block_id, source_block_id, line, byte_start, byte_end, snippet) VALUES `)
		args := make([]any, 0, len(chunk)*10)
		for i, r := range chunk {
			if i > 0 {
				q.WriteByte(',')
			}
			q.WriteString(`(?,?,?,?,?,?,?,?,?,?)`)
			args = append(args, r.sourcePath, r.kind, r.targetTitle, r.targetSlug, r.blockID, r.sourceBlockID, r.line, r.byteStart, r.byteEnd, r.snippet)
		}
		if _, err := tx.ExecContext(ctx, q.String(), args...); err != nil {
			return err
		}
	}
	return nil
}

func prepareBatchStmts(ctx context.Context, tx *sql.Tx) (*batchStmts, error) {
	var s batchStmts
	var err error
	closeOnErr := func() { s.close() }

	if s.updateNote, err = tx.PrepareContext(ctx, `
		UPDATE pkm_notes
		SET slug = ?, title = ?, tier = ?, sha256 = ?, frontmatter_json = ?, tags_json = ?, body = ?, updated_at_ms = ?
		WHERE id = ?`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.insertNote, err = tx.PrepareContext(ctx, `
		INSERT INTO pkm_notes (rel_path, slug, title, tier, sha256, frontmatter_json, tags_json, body, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.deleteAlias, err = tx.PrepareContext(ctx, `DELETE FROM pkm_aliases WHERE rel_path = ?`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.insertAlias, err = tx.PrepareContext(ctx, `INSERT OR IGNORE INTO pkm_aliases (alias_slug, rel_path) VALUES (?, ?)`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.deleteBlock, err = tx.PrepareContext(ctx, `DELETE FROM pkm_blocks WHERE rel_path = ?`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.deleteLink, err = tx.PrepareContext(ctx, `DELETE FROM pkm_links WHERE source_path = ?`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.deleteFTS, err = tx.PrepareContext(ctx, `DELETE FROM pkm_notes_fts WHERE rowid = ?`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.insertFTS, err = tx.PrepareContext(ctx, `
		INSERT INTO pkm_notes_fts (rowid, rel_path, title, tags, body)
		VALUES (?, ?, ?, ?, ?)`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.deleteVec, err = tx.PrepareContext(ctx, `DELETE FROM _vec_`+vecTableName+` WHERE dataset_id = ? AND id = ?`); err != nil {
		closeOnErr()
		return nil, err
	}
	if s.upsertVec, err = tx.PrepareContext(ctx, `
		INSERT INTO _vec_`+vecTableName+` (dataset_id, id, content, meta, embedding)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(dataset_id, id) DO UPDATE SET
			content = excluded.content,
			meta = excluded.meta,
			embedding = excluded.embedding`); err != nil {
		closeOnErr()
		return nil, err
	}
	return &s, nil
}

func (s *batchStmts) close() {
	for _, st := range []*sql.Stmt{
		s.updateNote, s.insertNote, s.deleteAlias, s.insertAlias,
		s.deleteBlock, s.deleteLink,
		s.deleteFTS, s.insertFTS, s.deleteVec, s.upsertVec,
	} {
		if st != nil {
			_ = st.Close()
		}
	}
}

func deleteNoteDetails(ctx context.Context, stmts *batchStmts, relPath string, noteID int64) error {
	if _, err := stmts.deleteAlias.ExecContext(ctx, relPath); err != nil {
		return err
	}
	if _, err := stmts.deleteBlock.ExecContext(ctx, relPath); err != nil {
		return err
	}
	if _, err := stmts.deleteLink.ExecContext(ctx, relPath); err != nil {
		return err
	}
	if _, err := stmts.deleteFTS.ExecContext(ctx, noteID); err != nil {
		return err
	}
	return nil
}

func loadExistingNoteIDs(ctx context.Context, tx *sql.Tx) (map[string]int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, rel_path FROM pkm_notes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int64)
	for rows.Next() {
		var id int64
		var relPath string
		if err := rows.Scan(&id, &relPath); err != nil {
			return nil, err
		}
		out[relPath] = id
	}
	return out, rows.Err()
}

func parseInputsParallel(ctx context.Context, inputs []NoteInput) ([]Note, error) {
	notes := make([]Note, len(inputs))
	if len(inputs) == 1 {
		n, err := ParseNote(inputs[0].RelPath, inputs[0].Content)
		if err != nil {
			return nil, err
		}
		n.UpdatedAtMs = inputs[0].UpdatedAtMs
		notes[0] = n
		return notes, nil
	}

	workers := min(8, len(inputs))
	jobs := make(chan int, workers*2)
	var firstErr error
	var errOnce sync.Once
	var wg sync.WaitGroup

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				if err := ctx.Err(); err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				n, err := ParseNote(inputs[idx].RelPath, inputs[idx].Content)
				if err != nil {
					errOnce.Do(func() { firstErr = err })
					return
				}
				n.UpdatedAtMs = inputs[idx].UpdatedAtMs
				notes[idx] = n
			}
		}()
	}

	for i := range inputs {
		if ctx.Err() != nil {
			break
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return notes, nil
}

func scanBacklinkViews(rows *sql.Rows) ([]contract.BacklinkView, error) {
	var out []contract.BacklinkView
	for rows.Next() {
		var bv contract.BacklinkView
		if err := rows.Scan(&bv.SourcePath, &bv.TargetTitle, &bv.BlockID, &bv.Line, &bv.ByteStart, &bv.ByteEnd, &bv.Snippet); err != nil {
			return nil, err
		}
		out = append(out, bv)
	}
	return out, rows.Err()
}

func inClause(vals []string) (string, []any) {
	placeholders := make([]string, len(vals))
	args := make([]any, len(vals))
	for i, v := range vals {
		placeholders[i] = "?"
		args[i] = v
	}
	return strings.Join(placeholders, ","), args
}

func containsTagFold(tags []string, cleanLower string) bool {
	for _, t := range tags {
		if strings.ToLower(strings.TrimPrefix(t, "#")) == cleanLower {
			return true
		}
	}
	return false
}

func extractSnippet(body, query string) string {
	lines := strings.Split(body, "\n")
	if query != "" {
		lowerQ := strings.ToLower(query)
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" && strings.Contains(strings.ToLower(trimmed), lowerQ) {
				return trimmed
			}
		}
		for _, term := range strings.Fields(lowerQ) {
			for _, line := range lines {
				trimmed := strings.TrimSpace(line)
				if trimmed != "" && strings.Contains(strings.ToLower(trimmed), term) {
					return trimmed
				}
			}
		}
	}
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
