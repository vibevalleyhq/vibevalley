package pkm

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// fts_raw.go isolates SQLite FTS5 virtual-table rowid/MATCH queries (which sqlc v1.31.1
// cannot parse directly) and multi-row bulk INSERT builders for 5,000-note batch indexing.

type ftsBatchStmts struct {
	deleteFTS *sql.Stmt
	insertFTS *sql.Stmt
}

func prepareFTSBatchStmts(ctx context.Context, tx *sql.Tx) (*ftsBatchStmts, error) {
	var s ftsBatchStmts
	var err error
	if s.deleteFTS, err = tx.PrepareContext(ctx, `DELETE FROM pkm_notes_fts WHERE rowid = ?`); err != nil {
		return nil, err
	}
	if s.insertFTS, err = tx.PrepareContext(ctx, `
		INSERT INTO pkm_notes_fts (rowid, rel_path, title, tags, body)
		VALUES (?, ?, ?, ?, ?)`); err != nil {
		_ = s.deleteFTS.Close()
		return nil, err
	}
	return &s, nil
}

func (s *ftsBatchStmts) close() {
	if s == nil {
		return
	}
	if s.deleteFTS != nil {
		_ = s.deleteFTS.Close()
	}
	if s.insertFTS != nil {
		_ = s.insertFTS.Close()
	}
}

func (s *ftsBatchStmts) deleteByNoteID(ctx context.Context, noteID int64) error {
	_, err := s.deleteFTS.ExecContext(ctx, noteID)
	return err
}

func (s *ftsBatchStmts) insert(ctx context.Context, noteID int64, relPath, title, tags, body string) error {
	_, err := s.insertFTS.ExecContext(ctx, noteID, relPath, title, tags, body)
	return err
}

func deleteNoteFTS(ctx context.Context, tx *sql.Tx, noteID int64) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM pkm_notes_fts WHERE rowid = ?`, noteID)
	return err
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

func searchFTS5Phrase(ctx context.Context, db *sql.DB, queryText string, limit int, scores map[string]float64) error {
	expr := ftsPhraseQuote(queryText)
	rows, err := db.QueryContext(ctx, `
		SELECT rel_path, -bm25(pkm_notes_fts, 4.0, 2.0, 1.0) AS rank_score
		FROM pkm_notes_fts
		WHERE pkm_notes_fts MATCH ?
		ORDER BY rank_score DESC
		LIMIT ?`, expr, limit,
	)
	if err != nil {
		return fmt.Errorf("pkm: fts5 trigram phrase search: %w", err)
	}
	for rows.Next() {
		var p string
		var sc float64
		if err := rows.Scan(&p, &sc); err != nil {
			_ = rows.Close()
			return err
		}
		// Exact phrase matches get a +5.0 bonus over split-term OR matches.
		if cur := sc + 5.0; cur > scores[p] {
			scores[p] = cur
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	return rows.Close()
}

func searchFTS5Terms(ctx context.Context, db *sql.DB, trigramTerms []string, limit int, scores map[string]float64) error {
	quoted := make([]string, 0, len(trigramTerms))
	for _, t := range trigramTerms {
		quoted = append(quoted, ftsPhraseQuote(t))
	}
	expr := strings.Join(quoted, " OR ")
	rows, err := db.QueryContext(ctx, `
		SELECT rel_path, -bm25(pkm_notes_fts, 4.0, 2.0, 1.0) AS rank_score
		FROM pkm_notes_fts
		WHERE pkm_notes_fts MATCH ?
		ORDER BY rank_score DESC
		LIMIT ?`, expr, limit,
	)
	if err != nil {
		return fmt.Errorf("pkm: fts5 trigram term search: %w", err)
	}
	for rows.Next() {
		var p string
		var sc float64
		if err := rows.Scan(&p, &sc); err != nil {
			_ = rows.Close()
			return err
		}
		if _, ok := scores[p]; !ok {
			scores[p] = sc
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	return rows.Close()
}

func ftsPhraseQuote(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}
