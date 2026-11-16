package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	_ "modernc.org/sqlite"
)

// SchemaDDL lists the six dialect-portable tables and indexes without SQL-level JSON path mutations.
var SchemaDDL = []string{
	`CREATE TABLE IF NOT EXISTS durable_conversation (
		id TEXT PRIMARY KEY,
		owner_task_id TEXT NOT NULL DEFAULT '',
		parent_id TEXT NOT NULL DEFAULT '',
		fork_entry_seq INTEGER NOT NULL DEFAULT 0,
		head_seq INTEGER NOT NULL DEFAULT 1,
		next_seq INTEGER NOT NULL DEFAULT 1,
		provider_affinity TEXT NOT NULL DEFAULT '',
		metadata_json TEXT NOT NULL DEFAULT '{}',
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS durable_conversation_owner_idx ON durable_conversation(owner_task_id)`,

	`CREATE TABLE IF NOT EXISTS durable_entry (
		conversation_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		kind TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		created_at_ms INTEGER NOT NULL,
		PRIMARY KEY (conversation_id, seq)
	)`,

	`CREATE TABLE IF NOT EXISTS durable_document (
		scope_kind TEXT NOT NULL,
		scope_id TEXT NOT NULL,
		doc_kind TEXT NOT NULL,
		rev INTEGER NOT NULL,
		state_json TEXT NOT NULL,
		updated_at_ms INTEGER NOT NULL,
		PRIMARY KEY (scope_kind, scope_id, doc_kind)
	)`,

	`CREATE TABLE IF NOT EXISTS durable_submission (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		request_id TEXT NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		notify_task_id TEXT NOT NULL DEFAULT '',
		result_json TEXT NOT NULL DEFAULT '{}',
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL,
		UNIQUE(conversation_id, request_id)
	)`,

	`CREATE TABLE IF NOT EXISTS durable_task (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL DEFAULT '',
		owner_task_id TEXT NOT NULL DEFAULT '',
		dedup_key TEXT NOT NULL DEFAULT '',
		kind TEXT NOT NULL,
		is_model_task INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		terminal_reason TEXT NOT NULL DEFAULT '',
		restart_count INTEGER NOT NULL DEFAULT 0,
		restart_limit INTEGER NOT NULL DEFAULT 5,
		phase_name TEXT NOT NULL DEFAULT '',
		checkpoint_json TEXT NOT NULL DEFAULT '{}',
		wake_until_ms INTEGER NOT NULL DEFAULT 0,
		wait_mode TEXT NOT NULL DEFAULT '',
		wait_task_ids_json TEXT NOT NULL DEFAULT '[]',
		wait_signal_name TEXT NOT NULL DEFAULT '',
		memo_json TEXT NOT NULL DEFAULT '{}',
		result_json TEXT NOT NULL DEFAULT '{}',
		error_text TEXT NOT NULL DEFAULT '',
		created_at_ms INTEGER NOT NULL,
		updated_at_ms INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS durable_task_owner_dedup ON durable_task(owner_task_id, dedup_key) WHERE dedup_key <> ''`,
	`CREATE INDEX IF NOT EXISTS durable_task_owner_idx ON durable_task(owner_task_id)`,
	`CREATE INDEX IF NOT EXISTS durable_task_status_idx ON durable_task(status)`,
	`CREATE INDEX IF NOT EXISTS durable_task_conv_idx ON durable_task(conversation_id)`,

	`CREATE TABLE IF NOT EXISTS durable_signal (
		id TEXT PRIMARY KEY,
		insert_seq INTEGER NOT NULL,
		task_id TEXT NOT NULL,
		signal_name TEXT NOT NULL,
		signal_key TEXT NOT NULL DEFAULT '',
		payload_json TEXT NOT NULL DEFAULT '{}',
		consumed INTEGER NOT NULL DEFAULT 0,
		consumed_at_ms INTEGER NOT NULL DEFAULT 0,
		created_at_ms INTEGER NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS durable_signal_task_key ON durable_signal(task_id, signal_name, signal_key) WHERE signal_key <> ''`,
	`CREATE INDEX IF NOT EXISTS durable_signal_task_pending_idx ON durable_signal(task_id, signal_name, consumed)`,
}

type queryExecutor interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type sqliteBackend struct {
	writeDB      *sql.DB
	readDB       *sql.DB
	sameDB       bool
	nextSigOrder atomic.Int64
}

func openSQLiteBackend(ctx context.Context, path string) (*sqliteBackend, error) {
	if path == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	isMem := path == ":memory:" || strings.Contains(path, "mode=memory") || strings.Contains(path, ":memory:")
	if !isMem && !strings.HasPrefix(path, "file:") {
		if dir := filepath.Dir(path); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("durable/store: mkdir %s: %w", dir, err)
			}
		}
	}

	writeDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("durable/store: open sqlite writer: %w", err)
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
			return nil, fmt.Errorf("durable/store: %s: %w", p, err)
		}
	}

	for _, ddl := range SchemaDDL {
		if _, err := writeDB.ExecContext(ctx, ddl); err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("durable/store: apply schema: %w", err)
		}
	}

	var maxSig int64
	if err := writeDB.QueryRowContext(ctx, `SELECT COALESCE(MAX(insert_seq), 0) FROM durable_signal`).Scan(&maxSig); err != nil {
		_ = writeDB.Close()
		return nil, fmt.Errorf("durable/store: read signal sequence: %w", err)
	}

	var readDB *sql.DB
	sameDB := false
	if isMem {
		readDB = writeDB
		sameDB = true
	} else {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		readDSN := path + sep + "_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
		readDB, err = sql.Open("sqlite", readDSN)
		if err != nil {
			_ = writeDB.Close()
			return nil, fmt.Errorf("durable/store: open sqlite reader: %w", err)
		}
		readDB.SetMaxOpenConns(4)
	}

	b := &sqliteBackend{
		writeDB: writeDB,
		readDB:  readDB,
		sameDB:  sameDB,
	}
	b.nextSigOrder.Store(maxSig)
	return b, nil
}

func (b *sqliteBackend) pragmas(ctx context.Context) (journalMode string, synchronous int, err error) {
	if err := b.writeDB.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		return "", 0, err
	}
	if err := b.writeDB.QueryRowContext(ctx, `PRAGMA synchronous`).Scan(&synchronous); err != nil {
		return "", 0, err
	}
	return strings.ToLower(journalMode), synchronous, nil
}

func (b *sqliteBackend) beginTx(ctx context.Context) (backendTx, error) {
	tx, err := b.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	return &sqliteTx{backend: b, tx: tx}, nil
}

func (b *sqliteBackend) read(_ context.Context) backendReader {
	return &sqliteReader{q: b.readDB}
}

func (b *sqliteBackend) close() error {
	var firstErr error
	if !b.sameDB && b.readDB != nil {
		if err := b.readDB.Close(); err != nil {
			firstErr = err
		}
	}
	if b.writeDB != nil {
		if err := b.writeDB.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

type sqliteReader struct {
	q queryExecutor
}

func (r *sqliteReader) getConversation(ctx context.Context, id string) (Conversation, bool, error) {
	return sqlGetConversation(ctx, r.q, id)
}

func (r *sqliteReader) listConversationsByOwnerTask(ctx context.Context, ownerTaskID string) ([]Conversation, error) {
	return sqlListConversationsByOwnerTask(ctx, r.q, ownerTaskID)
}

func (r *sqliteReader) listEntries(ctx context.Context, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	return sqlListEntries(ctx, r.q, conversationID, fromSeq, maxSeq)
}

func (r *sqliteReader) getDocument(ctx context.Context, key DocKey) (Document, bool, error) {
	return sqlGetDocument(ctx, r.q, key)
}

func (r *sqliteReader) listDocumentsByScope(ctx context.Context, scopeKind, scopeID string) ([]Document, error) {
	return sqlListDocumentsByScope(ctx, r.q, scopeKind, scopeID)
}

func (r *sqliteReader) getSubmission(ctx context.Context, id string) (Submission, bool, error) {
	return sqlGetSubmission(ctx, r.q, id)
}

func (r *sqliteReader) getSubmissionByRequestID(ctx context.Context, conversationID, requestID string) (Submission, bool, error) {
	return sqlGetSubmissionByRequestID(ctx, r.q, conversationID, requestID)
}

func (r *sqliteReader) getTask(ctx context.Context, id string) (Task, bool, error) {
	return sqlGetTask(ctx, r.q, id)
}

func (r *sqliteReader) getTaskByDedupKey(ctx context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	return sqlGetTaskByDedupKey(ctx, r.q, ownerTaskID, dedupKey)
}

func (r *sqliteReader) listTasksByOwner(ctx context.Context, ownerTaskID string) ([]Task, error) {
	return sqlListTasksByOwner(ctx, r.q, ownerTaskID)
}

func (r *sqliteReader) listTasksByStatus(ctx context.Context, statuses []TaskStatus) ([]Task, error) {
	return sqlListTasksByStatus(ctx, r.q, statuses)
}

func (r *sqliteReader) listTasksByConversation(ctx context.Context, conversationID string) ([]Task, error) {
	return sqlListTasksByConversation(ctx, r.q, conversationID)
}

func (r *sqliteReader) listSignals(ctx context.Context, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	return sqlListSignals(ctx, r.q, taskID, signalName, onlyUnconsumed)
}

type sqliteTx struct {
	backend *sqliteBackend
	tx      *sql.Tx
}

func (t *sqliteTx) savepoint(ctx context.Context, name string) error {
	_, err := t.tx.ExecContext(ctx, "SAVEPOINT "+name)
	return err
}

func (t *sqliteTx) rollbackToSavepoint(ctx context.Context, name string) error {
	if _, err := t.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT "+name); err != nil {
		return err
	}
	_, err := t.tx.ExecContext(ctx, "RELEASE SAVEPOINT "+name)
	return err
}

func (t *sqliteTx) releaseSavepoint(ctx context.Context, name string) error {
	_, err := t.tx.ExecContext(ctx, "RELEASE SAVEPOINT "+name)
	return err
}

func (t *sqliteTx) commit(_ context.Context) error { return t.tx.Commit() }
func (t *sqliteTx) rollback() error                { return t.tx.Rollback() }

func (t *sqliteTx) getConversation(ctx context.Context, id string) (Conversation, bool, error) {
	return sqlGetConversation(ctx, t.tx, id)
}

func (t *sqliteTx) listConversationsByOwnerTask(ctx context.Context, ownerTaskID string) ([]Conversation, error) {
	return sqlListConversationsByOwnerTask(ctx, t.tx, ownerTaskID)
}

func (t *sqliteTx) listEntries(ctx context.Context, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	return sqlListEntries(ctx, t.tx, conversationID, fromSeq, maxSeq)
}

func (t *sqliteTx) getDocument(ctx context.Context, key DocKey) (Document, bool, error) {
	return sqlGetDocument(ctx, t.tx, key)
}

func (t *sqliteTx) listDocumentsByScope(ctx context.Context, scopeKind, scopeID string) ([]Document, error) {
	return sqlListDocumentsByScope(ctx, t.tx, scopeKind, scopeID)
}

func (t *sqliteTx) getSubmission(ctx context.Context, id string) (Submission, bool, error) {
	return sqlGetSubmission(ctx, t.tx, id)
}

func (t *sqliteTx) getSubmissionByRequestID(ctx context.Context, conversationID, requestID string) (Submission, bool, error) {
	return sqlGetSubmissionByRequestID(ctx, t.tx, conversationID, requestID)
}

func (t *sqliteTx) getTask(ctx context.Context, id string) (Task, bool, error) {
	return sqlGetTask(ctx, t.tx, id)
}

func (t *sqliteTx) getTaskByDedupKey(ctx context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	return sqlGetTaskByDedupKey(ctx, t.tx, ownerTaskID, dedupKey)
}

func (t *sqliteTx) listTasksByOwner(ctx context.Context, ownerTaskID string) ([]Task, error) {
	return sqlListTasksByOwner(ctx, t.tx, ownerTaskID)
}

func (t *sqliteTx) listTasksByStatus(ctx context.Context, statuses []TaskStatus) ([]Task, error) {
	return sqlListTasksByStatus(ctx, t.tx, statuses)
}

func (t *sqliteTx) listTasksByConversation(ctx context.Context, conversationID string) ([]Task, error) {
	return sqlListTasksByConversation(ctx, t.tx, conversationID)
}

func (t *sqliteTx) listSignals(ctx context.Context, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	return sqlListSignals(ctx, t.tx, taskID, signalName, onlyUnconsumed)
}

func (t *sqliteTx) insertConversation(ctx context.Context, conv Conversation) error {
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO durable_conversation (
			id, owner_task_id, parent_id, fork_entry_seq, head_seq, next_seq,
			provider_affinity, metadata_json, created_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		conv.ID, conv.OwnerTaskID, conv.ParentID, conv.ForkEntrySeq, conv.HeadSeq, conv.NextSeq,
		conv.ProviderAffinity, string(conv.MetadataJSON), conv.CreatedAtMs, conv.UpdatedAtMs,
	)
	return classifySQLiteErr(err)
}

func (t *sqliteTx) updateConversation(ctx context.Context, conv Conversation) error {
	res, err := t.tx.ExecContext(ctx, `
		UPDATE durable_conversation
		SET head_seq = ?, next_seq = ?, metadata_json = ?, updated_at_ms = ?
		WHERE id = ?`,
		conv.HeadSeq, conv.NextSeq, string(conv.MetadataJSON), conv.UpdatedAtMs, conv.ID,
	)
	if err != nil {
		return classifySQLiteErr(err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (t *sqliteTx) insertEntry(ctx context.Context, entry Entry) error {
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO durable_entry (conversation_id, seq, kind, payload_json, created_at_ms)
		VALUES (?, ?, ?, ?, ?)`,
		entry.ConversationID, entry.Seq, entry.Kind, string(entry.PayloadJSON), entry.CreatedAtMs,
	)
	return classifySQLiteErr(err)
}

func (t *sqliteTx) upsertDocument(ctx context.Context, doc Document) (Document, error) {
	existing, found, err := sqlGetDocument(ctx, t.tx, DocKey{ScopeKind: doc.ScopeKind, ScopeID: doc.ScopeID, DocKind: doc.DocKind})
	if err != nil {
		return Document{}, err
	}
	if found {
		doc.Rev = existing.Rev + 1
		_, err = t.tx.ExecContext(ctx, `
			UPDATE durable_document
			SET rev = ?, state_json = ?, updated_at_ms = ?
			WHERE scope_kind = ? AND scope_id = ? AND doc_kind = ?`,
			doc.Rev, string(doc.StateJSON), doc.UpdatedAtMs, doc.ScopeKind, doc.ScopeID, doc.DocKind,
		)
	} else {
		doc.Rev = 1
		_, err = t.tx.ExecContext(ctx, `
			INSERT INTO durable_document (scope_kind, scope_id, doc_kind, rev, state_json, updated_at_ms)
			VALUES (?, ?, ?, ?, ?, ?)`,
			doc.ScopeKind, doc.ScopeID, doc.DocKind, doc.Rev, string(doc.StateJSON), doc.UpdatedAtMs,
		)
	}
	if err != nil {
		return Document{}, classifySQLiteErr(err)
	}
	return cloneDocument(doc), nil
}

func (t *sqliteTx) deleteDocument(ctx context.Context, key DocKey) (bool, error) {
	res, err := t.tx.ExecContext(ctx, `
		DELETE FROM durable_document
		WHERE scope_kind = ? AND scope_id = ? AND doc_kind = ?`,
		key.ScopeKind, key.ScopeID, key.DocKind,
	)
	if err != nil {
		return false, classifySQLiteErr(err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (t *sqliteTx) insertSubmission(ctx context.Context, sub Submission) error {
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO durable_submission (
			id, conversation_id, request_id, kind, status, payload_json,
			notify_task_id, result_json, created_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sub.ID, sub.ConversationID, sub.RequestID, sub.Kind, sub.Status, string(sub.PayloadJSON),
		sub.NotifyTaskID, string(sub.ResultJSON), sub.CreatedAtMs, sub.UpdatedAtMs,
	)
	return classifySQLiteErr(err)
}

func (t *sqliteTx) updateSubmission(ctx context.Context, sub Submission) error {
	res, err := t.tx.ExecContext(ctx, `
		UPDATE durable_submission
		SET status = ?, result_json = ?, updated_at_ms = ?
		WHERE id = ?`,
		sub.Status, string(sub.ResultJSON), sub.UpdatedAtMs, sub.ID,
	)
	if err != nil {
		return classifySQLiteErr(err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (t *sqliteTx) insertTask(ctx context.Context, task Task) error {
	waitIDsJSON, err := json.Marshal(nonNilSlice(task.WaitTaskIDs))
	if err != nil {
		return err
	}
	_, err = t.tx.ExecContext(ctx, `
		INSERT INTO durable_task (
			id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
			status, terminal_reason, restart_count, restart_limit, phase_name,
			checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
			memo_json, result_json, error_text, created_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		task.ID, task.ConversationID, task.OwnerTaskID, task.DedupKey, task.Kind, boolToInt(task.IsModelTask),
		string(task.Status), task.TerminalReason, task.RestartCount, task.RestartLimit, task.PhaseName,
		string(task.CheckpointJSON), task.WakeUntilMs, string(task.WaitMode), string(waitIDsJSON), task.WaitSignalName,
		string(task.MemoJSON), string(task.ResultJSON), task.ErrorText, task.CreatedAtMs, task.UpdatedAtMs,
	)
	return classifySQLiteErr(err)
}

func (t *sqliteTx) updateTask(ctx context.Context, task Task) error {
	waitIDsJSON, err := json.Marshal(nonNilSlice(task.WaitTaskIDs))
	if err != nil {
		return err
	}
	res, err := t.tx.ExecContext(ctx, `
		UPDATE durable_task
		SET status = ?, terminal_reason = ?, restart_count = ?, restart_limit = ?, phase_name = ?,
		    checkpoint_json = ?, wake_until_ms = ?, wait_mode = ?, wait_task_ids_json = ?, wait_signal_name = ?,
		    memo_json = ?, result_json = ?, error_text = ?, updated_at_ms = ?
		WHERE id = ?`,
		string(task.Status), task.TerminalReason, task.RestartCount, task.RestartLimit, task.PhaseName,
		string(task.CheckpointJSON), task.WakeUntilMs, string(task.WaitMode), string(waitIDsJSON), task.WaitSignalName,
		string(task.MemoJSON), string(task.ResultJSON), task.ErrorText, task.UpdatedAtMs, task.ID,
	)
	if err != nil {
		return classifySQLiteErr(err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (t *sqliteTx) insertSignal(ctx context.Context, sig Signal) error {
	seqOrder := t.backend.nextSigOrder.Add(1)
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO durable_signal (
			id, insert_seq, task_id, signal_name, signal_key, payload_json,
			consumed, consumed_at_ms, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sig.ID, seqOrder, sig.TaskID, sig.SignalName, sig.SignalKey, string(sig.PayloadJSON),
		boolToInt(sig.Consumed), sig.ConsumedAtMs, sig.CreatedAtMs,
	)
	return classifySQLiteErr(err)
}

func (t *sqliteTx) getSignalByKey(ctx context.Context, taskID, signalName, signalKey string) (Signal, bool, error) {
	if signalKey == "" {
		return Signal{}, false, nil
	}
	row := t.tx.QueryRowContext(ctx, `
		SELECT id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms
		FROM durable_signal
		WHERE task_id = ? AND signal_name = ? AND signal_key = ?`,
		taskID, signalName, signalKey,
	)
	sig, err := scanSignal(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Signal{}, false, nil
	}
	if err != nil {
		return Signal{}, false, err
	}
	return sig, true, nil
}

func (t *sqliteTx) markSignalConsumed(ctx context.Context, signalID string, consumedAtMs int64) error {
	res, err := t.tx.ExecContext(ctx, `
		UPDATE durable_signal
		SET consumed = 1, consumed_at_ms = ?
		WHERE id = ? AND consumed = 0`,
		consumedAtMs, signalID,
	)
	if err != nil {
		return classifySQLiteErr(err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		var exists int
		err2 := t.tx.QueryRowContext(ctx, `SELECT 1 FROM durable_signal WHERE id = ?`, signalID).Scan(&exists)
		if errors.Is(err2, sql.ErrNoRows) {
			return ErrNotFound
		}
		return ErrConflict
	}
	return nil
}

func sqlGetConversation(ctx context.Context, q queryExecutor, id string) (Conversation, bool, error) {
	row := q.QueryRowContext(ctx, `
		SELECT id, owner_task_id, parent_id, fork_entry_seq, head_seq, next_seq,
		       provider_affinity, metadata_json, created_at_ms, updated_at_ms
		FROM durable_conversation
		WHERE id = ?`, id)
	var conv Conversation
	var meta string
	err := row.Scan(
		&conv.ID, &conv.OwnerTaskID, &conv.ParentID, &conv.ForkEntrySeq, &conv.HeadSeq, &conv.NextSeq,
		&conv.ProviderAffinity, &meta, &conv.CreatedAtMs, &conv.UpdatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, false, nil
	}
	if err != nil {
		return Conversation{}, false, err
	}
	conv.MetadataJSON = []byte(meta)
	return conv, true, nil
}

func sqlListConversationsByOwnerTask(ctx context.Context, q queryExecutor, ownerTaskID string) ([]Conversation, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT id, owner_task_id, parent_id, fork_entry_seq, head_seq, next_seq,
		       provider_affinity, metadata_json, created_at_ms, updated_at_ms
		FROM durable_conversation
		WHERE owner_task_id = ?
		ORDER BY created_at_ms ASC, id ASC`, ownerTaskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Conversation
	for rows.Next() {
		var conv Conversation
		var meta string
		if err := rows.Scan(
			&conv.ID, &conv.OwnerTaskID, &conv.ParentID, &conv.ForkEntrySeq, &conv.HeadSeq, &conv.NextSeq,
			&conv.ProviderAffinity, &meta, &conv.CreatedAtMs, &conv.UpdatedAtMs,
		); err != nil {
			return nil, err
		}
		conv.MetadataJSON = []byte(meta)
		out = append(out, conv)
	}
	return out, rows.Err()
}

func sqlListEntries(ctx context.Context, q queryExecutor, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	var rows *sql.Rows
	var err error
	if maxSeq > 0 {
		rows, err = q.QueryContext(ctx, `
			SELECT conversation_id, seq, kind, payload_json, created_at_ms
			FROM durable_entry
			WHERE conversation_id = ? AND seq >= ? AND seq <= ?
			ORDER BY seq ASC`, conversationID, fromSeq, maxSeq)
	} else {
		rows, err = q.QueryContext(ctx, `
			SELECT conversation_id, seq, kind, payload_json, created_at_ms
			FROM durable_entry
			WHERE conversation_id = ? AND seq >= ?
			ORDER BY seq ASC`, conversationID, fromSeq)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		var payload string
		if err := rows.Scan(&e.ConversationID, &e.Seq, &e.Kind, &payload, &e.CreatedAtMs); err != nil {
			return nil, err
		}
		e.PayloadJSON = []byte(payload)
		out = append(out, e)
	}
	return out, rows.Err()
}

func sqlGetDocument(ctx context.Context, q queryExecutor, key DocKey) (Document, bool, error) {
	row := q.QueryRowContext(ctx, `
		SELECT scope_kind, scope_id, doc_kind, rev, state_json, updated_at_ms
		FROM durable_document
		WHERE scope_kind = ? AND scope_id = ? AND doc_kind = ?`,
		key.ScopeKind, key.ScopeID, key.DocKind,
	)
	var doc Document
	var state string
	err := row.Scan(&doc.ScopeKind, &doc.ScopeID, &doc.DocKind, &doc.Rev, &state, &doc.UpdatedAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, false, nil
	}
	if err != nil {
		return Document{}, false, err
	}
	doc.StateJSON = []byte(state)
	return doc, true, nil
}

func sqlListDocumentsByScope(ctx context.Context, q queryExecutor, scopeKind, scopeID string) ([]Document, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT scope_kind, scope_id, doc_kind, rev, state_json, updated_at_ms
		FROM durable_document
		WHERE scope_kind = ? AND scope_id = ?
		ORDER BY doc_kind ASC`, scopeKind, scopeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Document
	for rows.Next() {
		var doc Document
		var state string
		if err := rows.Scan(&doc.ScopeKind, &doc.ScopeID, &doc.DocKind, &doc.Rev, &state, &doc.UpdatedAtMs); err != nil {
			return nil, err
		}
		doc.StateJSON = []byte(state)
		out = append(out, doc)
	}
	return out, rows.Err()
}

func sqlGetSubmission(ctx context.Context, q queryExecutor, id string) (Submission, bool, error) {
	row := q.QueryRowContext(ctx, `
		SELECT id, conversation_id, request_id, kind, status, payload_json,
		       notify_task_id, result_json, created_at_ms, updated_at_ms
		FROM durable_submission
		WHERE id = ?`, id)
	return scanSubmissionRow(row)
}

func sqlGetSubmissionByRequestID(ctx context.Context, q queryExecutor, conversationID, requestID string) (Submission, bool, error) {
	row := q.QueryRowContext(ctx, `
		SELECT id, conversation_id, request_id, kind, status, payload_json,
		       notify_task_id, result_json, created_at_ms, updated_at_ms
		FROM durable_submission
		WHERE conversation_id = ? AND request_id = ?`, conversationID, requestID)
	return scanSubmissionRow(row)
}

func scanSubmissionRow(row *sql.Row) (Submission, bool, error) {
	var sub Submission
	var payload, result string
	err := row.Scan(
		&sub.ID, &sub.ConversationID, &sub.RequestID, &sub.Kind, &sub.Status, &payload,
		&sub.NotifyTaskID, &result, &sub.CreatedAtMs, &sub.UpdatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Submission{}, false, nil
	}
	if err != nil {
		return Submission{}, false, err
	}
	sub.PayloadJSON = []byte(payload)
	sub.ResultJSON = []byte(result)
	return sub, true, nil
}

const selectTaskCols = `
	id, conversation_id, owner_task_id, dedup_key, kind, is_model_task,
	status, terminal_reason, restart_count, restart_limit, phase_name,
	checkpoint_json, wake_until_ms, wait_mode, wait_task_ids_json, wait_signal_name,
	memo_json, result_json, error_text, created_at_ms, updated_at_ms
`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanTask(s rowScanner) (Task, error) {
	var t Task
	var isModel int
	var statusStr, waitModeStr string
	var cp, waitIDs, memo, result string
	if err := s.Scan(
		&t.ID, &t.ConversationID, &t.OwnerTaskID, &t.DedupKey, &t.Kind, &isModel,
		&statusStr, &t.TerminalReason, &t.RestartCount, &t.RestartLimit, &t.PhaseName,
		&cp, &t.WakeUntilMs, &waitModeStr, &waitIDs, &t.WaitSignalName,
		&memo, &result, &t.ErrorText, &t.CreatedAtMs, &t.UpdatedAtMs,
	); err != nil {
		return Task{}, err
	}
	t.IsModelTask = isModel != 0
	t.Status = TaskStatus(statusStr)
	t.WaitMode = WaitMode(waitModeStr)
	t.CheckpointJSON = []byte(cp)
	t.MemoJSON = []byte(memo)
	t.ResultJSON = []byte(result)
	if waitIDs != "" {
		var ids []string
		if err := json.Unmarshal([]byte(waitIDs), &ids); err != nil {
			return Task{}, err
		}
		if len(ids) > 0 {
			t.WaitTaskIDs = ids
		}
	}
	return t, nil
}

func sqlGetTask(ctx context.Context, q queryExecutor, id string) (Task, bool, error) {
	row := q.QueryRowContext(ctx, `SELECT `+selectTaskCols+` FROM durable_task WHERE id = ?`, id)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, err
	}
	return t, true, nil
}

func sqlGetTaskByDedupKey(ctx context.Context, q queryExecutor, ownerTaskID, dedupKey string) (Task, bool, error) {
	if dedupKey == "" {
		return Task{}, false, nil
	}
	row := q.QueryRowContext(ctx, `
		SELECT `+selectTaskCols+`
		FROM durable_task
		WHERE owner_task_id = ? AND dedup_key = ?`, ownerTaskID, dedupKey)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, err
	}
	return t, true, nil
}

func sqlListTasksByOwner(ctx context.Context, q queryExecutor, ownerTaskID string) ([]Task, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT `+selectTaskCols+`
		FROM durable_task
		WHERE owner_task_id = ?
		ORDER BY created_at_ms ASC, id ASC`, ownerTaskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTasksRows(rows)
}

func sqlListTasksByStatus(ctx context.Context, q queryExecutor, statuses []TaskStatus) ([]Task, error) {
	var rows *sql.Rows
	var err error
	if len(statuses) == 0 {
		rows, err = q.QueryContext(ctx, `SELECT `+selectTaskCols+` FROM durable_task ORDER BY created_at_ms ASC, id ASC`)
	} else {
		placeholders := make([]string, len(statuses))
		args := make([]any, len(statuses))
		for i, st := range statuses {
			placeholders[i] = "?"
			args[i] = string(st)
		}
		rows, err = q.QueryContext(ctx, `
			SELECT `+selectTaskCols+`
			FROM durable_task
			WHERE status IN (`+strings.Join(placeholders, ",")+`)
			ORDER BY created_at_ms ASC, id ASC`, args...)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTasksRows(rows)
}

func sqlListTasksByConversation(ctx context.Context, q queryExecutor, conversationID string) ([]Task, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT `+selectTaskCols+`
		FROM durable_task
		WHERE conversation_id = ?
		ORDER BY created_at_ms ASC, id ASC`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTasksRows(rows)
}

func scanTasksRows(rows *sql.Rows) ([]Task, error) {
	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func sqlListSignals(ctx context.Context, q queryExecutor, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	query := `
		SELECT id, task_id, signal_name, signal_key, payload_json, consumed, consumed_at_ms, created_at_ms
		FROM durable_signal
		WHERE task_id = ?`
	args := []any{taskID}
	if signalName != "" {
		query += ` AND signal_name = ?`
		args = append(args, signalName)
	}
	if onlyUnconsumed {
		query += ` AND consumed = 0`
	}
	query += ` ORDER BY created_at_ms ASC, insert_seq ASC`

	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Signal
	for rows.Next() {
		sig, err := scanSignal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sig)
	}
	return out, rows.Err()
}

func scanSignal(s rowScanner) (Signal, error) {
	var sig Signal
	var payload string
	var consumedInt int
	if err := s.Scan(
		&sig.ID, &sig.TaskID, &sig.SignalName, &sig.SignalKey, &payload,
		&consumedInt, &sig.ConsumedAtMs, &sig.CreatedAtMs,
	); err != nil {
		return Signal{}, err
	}
	sig.PayloadJSON = []byte(payload)
	sig.Consumed = consumedInt != 0
	return sig, nil
}

func classifySQLiteErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") || strings.Contains(msg, "PRIMARY KEY") {
		return fmt.Errorf("%w: %v", ErrDuplicate, err)
	}
	return err
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func nonNilSlice(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
