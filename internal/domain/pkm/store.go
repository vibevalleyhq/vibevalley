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

	"github.com/viant/sqlite-vec/vec"
	"github.com/viant/sqlite-vec/vector"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

const (
	vecTableName  = "pkm_vectors"
	vecShadowName = "main._vec_" + vecTableName

	defaultSearchLimit = 20
	defaultRRFK        = 60.0
)

var nextMemDatasetSeq atomic.Int64

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
	readQ     *dbgen.Queries
	sameDB    bool
	ownsDB    bool
	isMem     bool
	datasetID string

	mu     sync.Mutex
	closed atomic.Bool
}

func newStoreConfig(isMem bool, opts ...StoreOption) storeConfig {
	var cfg storeConfig
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	if cfg.datasetID == "" {
		if isMem {
			cfg.datasetID = fmt.Sprintf("pkm-mem-%d", nextMemDatasetSeq.Add(1))
		} else {
			cfg.datasetID = "pkm"
		}
	}
	return cfg
}

// OpenStoreFromPool constructs a PKM Store backed by a caller-owned SQLite pool.
// Callers retain ownership of writeDB and readDB; Close invalidates sqlite-vec caches without closing either handle.
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

	db.RegisterVec()
	if err := vec.Register(writeDB); err != nil {
		return nil, fmt.Errorf("pkm: register sqlite-vec writer: %w", err)
	}
	if readDB != writeDB {
		if err := vec.Register(readDB); err != nil {
			return nil, fmt.Errorf("pkm: register sqlite-vec reader: %w", err)
		}
	}

	cfg := newStoreConfig(isMem, opts...)
	return &Store{
		writeDB:   writeDB,
		readDB:    readDB,
		readQ:     dbgen.New(readDB),
		sameDB:    isMem || readDB == writeDB,
		ownsDB:    false,
		isMem:     isMem,
		datasetID: cfg.datasetID,
	}, nil
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

	pool, err := db.OpenPool(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pkm: %w", err)
	}

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("pkm: init migrations: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("pkm: apply schema: %w", err)
	}

	cfg := newStoreConfig(pool.IsMem, opts...)
	return &Store{
		writeDB:   pool.WriteDB,
		readDB:    pool.ReadDB,
		readQ:     dbgen.New(pool.ReadDB),
		sameDB:    pool.SameDB,
		ownsDB:    true,
		isMem:     pool.IsMem,
		datasetID: cfg.datasetID,
	}, nil
}

// Close invalidates cached sqlite-vec indices and, when owned, releases SQLite connections.
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	if s.closed.Swap(true) {
		return nil
	}
	vec.InvalidateCache(vecShadowName, s.datasetID)
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

	txQ := dbgen.New(tx)

	ftsStmts, err := prepareFTSBatchStmts(ctx, tx)
	if err != nil {
		return nil, err
	}
	defer ftsStmts.close()

	existingIDs, err := loadExistingNoteIDs(ctx, txQ)
	if err != nil {
		return nil, err
	}

	wroteVectors := false
	pendingBlocks := make([]pendingBlockRow, 0, len(notes))
	pendingLinks := make([]pendingLinkRow, 0, len(notes)*2)

	for i, note := range notes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		noteID, exists := existingIDs[note.RelPath]
		if exists {
			if err := deleteNoteDetails(ctx, txQ, ftsStmts, note.RelPath, noteID); err != nil {
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
			if err := txQ.UpdateNote(ctx, dbgen.UpdateNoteParams{
				Slug:            note.Slug,
				Title:           note.Title,
				Tier:            string(note.Tier),
				Sha256:          note.SHA256,
				FrontmatterJson: string(fmJSON),
				TagsJson:        string(tagsJSON),
				Body:            note.Body,
				UpdatedAtMs:     note.UpdatedAtMs,
				ID:              noteID,
			}); err != nil {
				return nil, err
			}
			assignedID = noteID
		} else {
			res, err := txQ.InsertNote(ctx, dbgen.InsertNoteParams{
				RelPath:         note.RelPath,
				Slug:            note.Slug,
				Title:           note.Title,
				Tier:            string(note.Tier),
				Sha256:          note.SHA256,
				FrontmatterJson: string(fmJSON),
				TagsJson:        string(tagsJSON),
				Body:            note.Body,
				UpdatedAtMs:     note.UpdatedAtMs,
			})
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
				if err := txQ.InsertAlias(ctx, dbgen.InsertAliasParams{
					AliasSlug: aliasSlug,
					RelPath:   note.RelPath,
				}); err != nil {
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
		if err := ftsStmts.insert(ctx, assignedID, note.RelPath, ftsTitle, ftsTags, ftsBody); err != nil {
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
			if err := txQ.UpsertVector(ctx, dbgen.UpsertVectorParams{
				DatasetID: s.datasetID,
				ID:        note.RelPath,
				Content:   sql.NullString{String: note.Title, Valid: true},
				Meta:      sql.NullString{String: string(metaJSON), Valid: true},
				Embedding: blob,
			}); err != nil {
				return nil, err
			}
			wroteVectors = true
		} else if exists {
			n, err := txQ.DeleteVectorByID(ctx, dbgen.DeleteVectorByIDParams{
				DatasetID: s.datasetID,
				ID:        note.RelPath,
			})
			if err != nil {
				return nil, err
			}
			if n > 0 {
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
		if err := txQ.DeleteVectorStorage(ctx, dbgen.DeleteVectorStorageParams{
			ShadowTableName: vecShadowName,
			DatasetID:       s.datasetID,
		}); err != nil {
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

	txQ := dbgen.New(tx)
	noteID, err := txQ.GetNoteIDByPath(ctx, clean)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	if err := txQ.DeleteAliasesByPath(ctx, clean); err != nil {
		return err
	}
	if err := txQ.DeleteBlocksByPath(ctx, clean); err != nil {
		return err
	}
	if err := txQ.DeleteLinksBySourcePath(ctx, clean); err != nil {
		return err
	}
	if err := deleteNoteFTS(ctx, tx, noteID); err != nil {
		return err
	}
	if _, err := txQ.DeleteVectorByID(ctx, dbgen.DeleteVectorByIDParams{
		DatasetID: s.datasetID,
		ID:        clean,
	}); err != nil {
		return err
	}
	if err := txQ.DeleteVectorStorage(ctx, dbgen.DeleteVectorStorageParams{
		ShadowTableName: vecShadowName,
		DatasetID:       s.datasetID,
	}); err != nil {
		return err
	}
	if err := txQ.DeleteNoteByID(ctx, noteID); err != nil {
		return err
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
	row, err := s.readQ.GetNoteByPathOrRef(ctx, dbgen.GetNoteByPathOrRefParams{
		RelPath: clean,
		Slug:    slug,
		LOWER:   strings.TrimSpace(pathOrRef),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, false, nil
	}
	if err != nil {
		return Note{}, false, err
	}

	n := Note{
		RelPath:     row.RelPath,
		Slug:        row.Slug,
		Title:       row.Title,
		Tier:        Tier(row.Tier),
		SHA256:      row.Sha256,
		Body:        row.Body,
		UpdatedAtMs: row.UpdatedAtMs,
	}
	if err := json.Unmarshal([]byte(row.FrontmatterJson), &n.Frontmatter); err != nil {
		return Note{}, false, err
	}
	if err := json.Unmarshal([]byte(row.TagsJson), &n.Tags); err != nil {
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

	rows, err := s.readQ.ListBlockBacklinks(ctx, bid)
	if err != nil {
		return nil, err
	}
	out := make([]contract.BacklinkView, 0, len(rows))
	for _, r := range rows {
		out = append(out, contract.BacklinkView{
			SourcePath:  r.SourcePath,
			TargetTitle: r.TargetTitle,
			BlockID:     r.BlockID,
			Line:        int(r.Line),
			ByteStart:   int(r.ByteStart),
			ByteEnd:     int(r.ByteEnd),
			Snippet:     r.Snippet,
		})
	}
	return out, nil
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

	row, err := s.readQ.ResolveBlock(ctx, strings.TrimSpace(blockID))
	if errors.Is(err, sql.ErrNoRows) {
		return BlockDef{}, "", false, nil
	}
	if err != nil {
		return BlockDef{}, "", false, err
	}
	return BlockDef{
		ID:        row.BlockID,
		Body:      row.Body,
		Line:      int(row.Line),
		ByteStart: int(row.ByteStart),
		ByteEnd:   int(row.ByteEnd),
	}, row.RelPath, true, nil
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
		if err := searchFTS5Phrase(ctx, s.readDB, queryText, limit, scores); err != nil {
			return nil, err
		}
	}

	if len(trigramTerms) > 0 && (len(trigramTerms) > 1 || len(scores) < limit) {
		if err := searchFTS5Terms(ctx, s.readDB, trigramTerms, limit, scores); err != nil {
			return nil, err
		}
	}

	// Short (<3 rune) CJK/English tokens cannot form a 3-rune trigram in FTS5 MATCH;
	// supplement with exact substring matching via INSTR so 1-2 char queries work seamlessly.
	for _, st := range shortTerms {
		rows, err := s.readQ.SearchShortTerms(ctx, dbgen.SearchShortTermsParams{
			Term:       strings.ToLower(st),
			LimitCount: int64(limit),
		})
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			scores[r.RelPath] += r.S
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
	if len(targetSlugs) == 0 && (len(targetPaths) == 0 || kind == KindTag) {
		return nil, nil
	}

	usePaths := len(targetPaths) > 0 && kind != KindTag
	kindStr := string(kind)

	switch {
	case usePaths && kindStr != "":
		rows, err := s.readQ.QueryBacklinksBySlugsOrPathsAndKind(ctx, dbgen.QueryBacklinksBySlugsOrPathsAndKindParams{
			Kind:        kindStr,
			TargetSlugs: targetSlugs,
			TargetPaths: targetPaths,
		})
		if err != nil {
			return nil, err
		}
		out := make([]contract.BacklinkView, 0, len(rows))
		for _, r := range rows {
			out = append(out, contract.BacklinkView{
				SourcePath:  r.SourcePath,
				TargetTitle: r.TargetTitle,
				BlockID:     r.BlockID,
				Line:        int(r.Line),
				ByteStart:   int(r.ByteStart),
				ByteEnd:     int(r.ByteEnd),
				Snippet:     r.Snippet,
			})
		}
		return out, nil

	case usePaths:
		rows, err := s.readQ.QueryBacklinksBySlugsOrPaths(ctx, dbgen.QueryBacklinksBySlugsOrPathsParams{
			TargetSlugs: targetSlugs,
			TargetPaths: targetPaths,
		})
		if err != nil {
			return nil, err
		}
		out := make([]contract.BacklinkView, 0, len(rows))
		for _, r := range rows {
			out = append(out, contract.BacklinkView{
				SourcePath:  r.SourcePath,
				TargetTitle: r.TargetTitle,
				BlockID:     r.BlockID,
				Line:        int(r.Line),
				ByteStart:   int(r.ByteStart),
				ByteEnd:     int(r.ByteEnd),
				Snippet:     r.Snippet,
			})
		}
		return out, nil

	case kindStr != "":
		rows, err := s.readQ.QueryBacklinksBySlugsAndKind(ctx, dbgen.QueryBacklinksBySlugsAndKindParams{
			Kind:        kindStr,
			TargetSlugs: targetSlugs,
		})
		if err != nil {
			return nil, err
		}
		out := make([]contract.BacklinkView, 0, len(rows))
		for _, r := range rows {
			out = append(out, contract.BacklinkView{
				SourcePath:  r.SourcePath,
				TargetTitle: r.TargetTitle,
				BlockID:     r.BlockID,
				Line:        int(r.Line),
				ByteStart:   int(r.ByteStart),
				ByteEnd:     int(r.ByteEnd),
				Snippet:     r.Snippet,
			})
		}
		return out, nil

	default:
		rows, err := s.readQ.QueryBacklinksBySlugs(ctx, targetSlugs)
		if err != nil {
			return nil, err
		}
		out := make([]contract.BacklinkView, 0, len(rows))
		for _, r := range rows {
			out = append(out, contract.BacklinkView{
				SourcePath:  r.SourcePath,
				TargetTitle: r.TargetTitle,
				BlockID:     r.BlockID,
				Line:        int(r.Line),
				ByteStart:   int(r.ByteStart),
				ByteEnd:     int(r.ByteEnd),
				Snippet:     r.Snippet,
			})
		}
		return out, nil
	}
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
		noteRows, err := s.readQ.FindNotesBySlugsOrPath(ctx, dbgen.FindNotesBySlugsOrPathParams{
			RelPath: normalizeRelSlash(rawTarget),
			Slugs:   seedSlugs,
		})
		if err != nil {
			return nil, nil, err
		}
		for _, r := range noteRows {
			pathSet[r.RelPath] = struct{}{}
			if r.Slug != "" {
				slugSet[r.Slug] = struct{}{}
			}
		}

		// Also match pages whose alias matches the requested target.
		aliasRows, err := s.readQ.FindNotesByAliasSlugs(ctx, seedSlugs)
		if err != nil {
			return nil, nil, err
		}
		for _, r := range aliasRows {
			pathSet[r.RelPath] = struct{}{}
			if r.Slug != "" {
				slugSet[r.Slug] = struct{}{}
			}
		}
	}

	// Include aliases of any resolved page so links via alias also appear in backlinks.
	if len(pathSet) > 0 {
		paths := make([]string, 0, len(pathSet))
		for p := range pathSet {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		aliases, err := s.readQ.ListAliasSlugsByPaths(ctx, paths)
		if err != nil {
			return nil, nil, err
		}
		for _, as := range aliases {
			if as != "" {
				slugSet[as] = struct{}{}
			}
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
	rows, err := s.readQ.ListForwardLinks(ctx, sourcePath)
	if err != nil {
		return nil, err
	}
	out := make([]LinkSpan, 0, len(rows))
	for _, r := range rows {
		out = append(out, LinkSpan{
			Kind:          LinkKind(r.Kind),
			TargetSlug:    r.TargetSlug,
			SourceBlockID: r.SourceBlockID,
			Backlink: contract.BacklinkView{
				SourcePath:  sourcePath,
				TargetTitle: r.TargetTitle,
				BlockID:     r.BlockID,
				Line:        int(r.Line),
				ByteStart:   int(r.ByteStart),
				ByteEnd:     int(r.ByteEnd),
				Snippet:     r.Snippet,
			},
		})
	}
	return out, nil
}

func (s *Store) queryBlocksForPathLocked(ctx context.Context, relPath string) ([]BlockDef, error) {
	rows, err := s.readQ.ListBlocksByPath(ctx, relPath)
	if err != nil {
		return nil, err
	}
	out := make([]BlockDef, 0, len(rows))
	for _, r := range rows {
		out = append(out, BlockDef{
			ID:        r.BlockID,
			Body:      r.Body,
			Line:      int(r.Line),
			ByteStart: int(r.ByteStart),
			ByteEnd:   int(r.ByteEnd),
		})
	}
	return out, nil
}

func (s *Store) noteSHAs(ctx context.Context) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.readQ.ListNoteSHAs(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.RelPath] = r.Sha256
	}
	return out, nil
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

	var sourcePaths []string
	if len(paths) > 0 {
		sourcePaths, err = s.readQ.ListSourcePathsByTargetSlugsOrPaths(ctx, dbgen.ListSourcePathsByTargetSlugsOrPathsParams{
			TargetSlugs: slugs,
			TargetPaths: paths,
		})
	} else {
		sourcePaths, err = s.readQ.ListSourcePathsByTargetSlugs(ctx, slugs)
	}
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(sourcePaths))
	for _, p := range sourcePaths {
		out[p] = true
	}
	return out, nil
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
		rows, err := s.readQ.LoadSearchMetaByPaths(ctx, paths[start:end])
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			var tags []string
			if r.TagsJson != "" {
				_ = json.Unmarshal([]byte(r.TagsJson), &tags)
			}
			out[r.RelPath] = noteSearchMeta{
				title: r.Title,
				slug:  r.Slug,
				tier:  Tier(r.Tier),
				tags:  tags,
				body:  r.Body,
			}
		}
	}
	return out, nil
}

func (s *Store) loadBacklinkCountsLocked(ctx context.Context) (map[string]int, error) {
	rows, err := s.readQ.LoadBacklinkCounts(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.TargetSlug] = int(r.Cnt)
	}
	return out, nil
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
	rows, err := s.readQ.ListAllNotesForSearch(ctx)
	if err != nil {
		return nil, err
	}

	cleanTag := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(q.Tag, "#")))
	var hits []SearchHit
	for _, r := range rows {
		tier := Tier(r.Tier)
		if q.Tier != "" && tier != q.Tier {
			continue
		}
		var tags []string
		if r.TagsJson != "" {
			_ = json.Unmarshal([]byte(r.TagsJson), &tags)
		}
		if cleanTag != "" && !containsTagFold(tags, cleanTag) {
			continue
		}
		if linkedPaths != nil && !linkedPaths[r.RelPath] {
			continue
		}
		hits = append(hits, SearchHit{
			RelPath:       r.RelPath,
			Title:         r.Title,
			Slug:          r.Slug,
			Tier:          tier,
			Score:         TierWeight(tier),
			Snippet:       extractSnippet(r.Body, ""),
			Tags:          tags,
			BacklinkCount: backlinkCounts[r.Slug],
		})
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

func deleteNoteDetails(ctx context.Context, q *dbgen.Queries, fts *ftsBatchStmts, relPath string, noteID int64) error {
	if err := q.DeleteAliasesByPath(ctx, relPath); err != nil {
		return err
	}
	if err := q.DeleteBlocksByPath(ctx, relPath); err != nil {
		return err
	}
	if err := q.DeleteLinksBySourcePath(ctx, relPath); err != nil {
		return err
	}
	return fts.deleteByNoteID(ctx, noteID)
}

func loadExistingNoteIDs(ctx context.Context, q *dbgen.Queries) (map[string]int64, error) {
	rows, err := q.LoadExistingNoteIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, r := range rows {
		out[r.RelPath] = r.ID
	}
	return out, nil
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
