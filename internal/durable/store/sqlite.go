package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"

	"github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

type sqliteBackend struct {
	pool         *db.Pool
	writeDB      *sql.DB
	readDB       *sql.DB
	sameDB       bool
	ownsDB       bool
	nextSigOrder atomic.Int64
}

func openSQLiteBackend(ctx context.Context, path string) (*sqliteBackend, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("%w: empty sqlite path", ErrInvalidArgument)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	pool, err := db.OpenPool(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("durable/store: open sqlite pool: %w", err)
	}

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("durable/store: init migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("durable/store: apply migrations: %w", err)
	}

	maxSig, err := dbgen.New(pool.WriteDB).ReadMaxSignalInsertSeq(ctx)
	if err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("durable/store: read signal sequence: %w", err)
	}

	b := &sqliteBackend{
		pool:    pool,
		writeDB: pool.WriteDB,
		readDB:  pool.ReadDB,
		sameDB:  pool.SameDB,
		ownsDB:  true,
	}
	b.nextSigOrder.Store(maxSig)
	return b, nil
}

func openSQLiteFromPool(ctx context.Context, writeDB, readDB *sql.DB) (*sqliteBackend, error) {
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

	maxSig, err := dbgen.New(writeDB).ReadMaxSignalInsertSeq(ctx)
	if err != nil {
		return nil, fmt.Errorf("durable/store: read signal sequence: %w", err)
	}

	b := &sqliteBackend{
		writeDB: writeDB,
		readDB:  readDB,
		sameDB:  writeDB == readDB,
		ownsDB:  false,
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
	return &sqliteTx{backend: b, tx: tx, q: dbgen.New(tx)}, nil
}

func (b *sqliteBackend) read(_ context.Context) backendReader {
	return &sqliteReader{q: dbgen.New(b.readDB)}
}

func (b *sqliteBackend) close() error {
	if !b.ownsDB {
		return nil
	}
	if b.pool != nil {
		return b.pool.Close()
	}
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
	q *dbgen.Queries
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
	q       *dbgen.Queries
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
	return sqlGetConversation(ctx, t.q, id)
}

func (t *sqliteTx) listConversationsByOwnerTask(ctx context.Context, ownerTaskID string) ([]Conversation, error) {
	return sqlListConversationsByOwnerTask(ctx, t.q, ownerTaskID)
}

func (t *sqliteTx) listEntries(ctx context.Context, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	return sqlListEntries(ctx, t.q, conversationID, fromSeq, maxSeq)
}

func (t *sqliteTx) getDocument(ctx context.Context, key DocKey) (Document, bool, error) {
	return sqlGetDocument(ctx, t.q, key)
}

func (t *sqliteTx) listDocumentsByScope(ctx context.Context, scopeKind, scopeID string) ([]Document, error) {
	return sqlListDocumentsByScope(ctx, t.q, scopeKind, scopeID)
}

func (t *sqliteTx) getSubmission(ctx context.Context, id string) (Submission, bool, error) {
	return sqlGetSubmission(ctx, t.q, id)
}

func (t *sqliteTx) getSubmissionByRequestID(ctx context.Context, conversationID, requestID string) (Submission, bool, error) {
	return sqlGetSubmissionByRequestID(ctx, t.q, conversationID, requestID)
}

func (t *sqliteTx) getTask(ctx context.Context, id string) (Task, bool, error) {
	return sqlGetTask(ctx, t.q, id)
}

func (t *sqliteTx) getTaskByDedupKey(ctx context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	return sqlGetTaskByDedupKey(ctx, t.q, ownerTaskID, dedupKey)
}

func (t *sqliteTx) listTasksByOwner(ctx context.Context, ownerTaskID string) ([]Task, error) {
	return sqlListTasksByOwner(ctx, t.q, ownerTaskID)
}

func (t *sqliteTx) listTasksByStatus(ctx context.Context, statuses []TaskStatus) ([]Task, error) {
	return sqlListTasksByStatus(ctx, t.q, statuses)
}

func (t *sqliteTx) listTasksByConversation(ctx context.Context, conversationID string) ([]Task, error) {
	return sqlListTasksByConversation(ctx, t.q, conversationID)
}

func (t *sqliteTx) listSignals(ctx context.Context, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	return sqlListSignals(ctx, t.q, taskID, signalName, onlyUnconsumed)
}

func (t *sqliteTx) insertConversation(ctx context.Context, conv Conversation) error {
	err := t.q.InsertConversation(ctx, dbgen.InsertConversationParams{
		ID:               conv.ID,
		OwnerTaskID:      conv.OwnerTaskID,
		ParentID:         conv.ParentID,
		ForkEntrySeq:     conv.ForkEntrySeq,
		HeadSeq:          conv.HeadSeq,
		NextSeq:          conv.NextSeq,
		ProviderAffinity: conv.ProviderAffinity,
		MetadataJson:     string(conv.MetadataJSON),
		CreatedAtMs:      conv.CreatedAtMs,
		UpdatedAtMs:      conv.UpdatedAtMs,
	})
	return classifySQLiteErr(err)
}

func (t *sqliteTx) updateConversation(ctx context.Context, conv Conversation) error {
	n, err := t.q.UpdateConversation(ctx, dbgen.UpdateConversationParams{
		HeadSeq:      conv.HeadSeq,
		NextSeq:      conv.NextSeq,
		MetadataJson: string(conv.MetadataJSON),
		UpdatedAtMs:  conv.UpdatedAtMs,
		ID:           conv.ID,
	})
	if err != nil {
		return classifySQLiteErr(err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (t *sqliteTx) insertEntry(ctx context.Context, entry Entry) error {
	err := t.q.InsertEntry(ctx, dbgen.InsertEntryParams{
		ConversationID: entry.ConversationID,
		Seq:            entry.Seq,
		Kind:           entry.Kind,
		PayloadJson:    string(entry.PayloadJSON),
		CreatedAtMs:    entry.CreatedAtMs,
	})
	return classifySQLiteErr(err)
}

func (t *sqliteTx) upsertDocument(ctx context.Context, doc Document) (Document, error) {
	existing, found, err := sqlGetDocument(ctx, t.q, DocKey{ScopeKind: doc.ScopeKind, ScopeID: doc.ScopeID, DocKind: doc.DocKind})
	if err != nil {
		return Document{}, err
	}
	if found {
		doc.Rev = existing.Rev + 1
		err = t.q.UpdateDocument(ctx, dbgen.UpdateDocumentParams{
			Rev:         doc.Rev,
			StateJson:   string(doc.StateJSON),
			UpdatedAtMs: doc.UpdatedAtMs,
			ScopeKind:   doc.ScopeKind,
			ScopeID:     doc.ScopeID,
			DocKind:     doc.DocKind,
		})
	} else {
		doc.Rev = 1
		err = t.q.InsertDocument(ctx, dbgen.InsertDocumentParams{
			ScopeKind:   doc.ScopeKind,
			ScopeID:     doc.ScopeID,
			DocKind:     doc.DocKind,
			Rev:         doc.Rev,
			StateJson:   string(doc.StateJSON),
			UpdatedAtMs: doc.UpdatedAtMs,
		})
	}
	if err != nil {
		return Document{}, classifySQLiteErr(err)
	}
	return cloneDocument(doc), nil
}

func (t *sqliteTx) deleteDocument(ctx context.Context, key DocKey) (bool, error) {
	n, err := t.q.DeleteDocument(ctx, dbgen.DeleteDocumentParams{
		ScopeKind: key.ScopeKind,
		ScopeID:   key.ScopeID,
		DocKind:   key.DocKind,
	})
	if err != nil {
		return false, classifySQLiteErr(err)
	}
	return n > 0, nil
}

func (t *sqliteTx) insertSubmission(ctx context.Context, sub Submission) error {
	err := t.q.InsertSubmission(ctx, dbgen.InsertSubmissionParams{
		ID:             sub.ID,
		ConversationID: sub.ConversationID,
		RequestID:      sub.RequestID,
		Kind:           sub.Kind,
		Status:         sub.Status,
		PayloadJson:    string(sub.PayloadJSON),
		NotifyTaskID:   sub.NotifyTaskID,
		ResultJson:     string(sub.ResultJSON),
		CreatedAtMs:    sub.CreatedAtMs,
		UpdatedAtMs:    sub.UpdatedAtMs,
	})
	return classifySQLiteErr(err)
}

func (t *sqliteTx) updateSubmission(ctx context.Context, sub Submission) error {
	n, err := t.q.UpdateSubmission(ctx, dbgen.UpdateSubmissionParams{
		Status:      sub.Status,
		ResultJson:  string(sub.ResultJSON),
		UpdatedAtMs: sub.UpdatedAtMs,
		ID:          sub.ID,
	})
	if err != nil {
		return classifySQLiteErr(err)
	}
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
	err = t.q.InsertTask(ctx, dbgen.InsertTaskParams{
		ID:              task.ID,
		ConversationID:  task.ConversationID,
		OwnerTaskID:     task.OwnerTaskID,
		DedupKey:        task.DedupKey,
		Kind:            task.Kind,
		IsModelTask:     int64(boolToInt(task.IsModelTask)),
		Status:          string(task.Status),
		TerminalReason:  task.TerminalReason,
		RestartCount:    int64(task.RestartCount),
		RestartLimit:    int64(task.RestartLimit),
		PhaseName:       task.PhaseName,
		CheckpointJson:  string(task.CheckpointJSON),
		WakeUntilMs:     task.WakeUntilMs,
		WaitMode:        string(task.WaitMode),
		WaitTaskIdsJson: string(waitIDsJSON),
		WaitSignalName:  task.WaitSignalName,
		MemoJson:        string(task.MemoJSON),
		ResultJson:      string(task.ResultJSON),
		ErrorText:       task.ErrorText,
		CreatedAtMs:     task.CreatedAtMs,
		UpdatedAtMs:     task.UpdatedAtMs,
	})
	return classifySQLiteErr(err)
}

func (t *sqliteTx) updateTask(ctx context.Context, task Task) error {
	waitIDsJSON, err := json.Marshal(nonNilSlice(task.WaitTaskIDs))
	if err != nil {
		return err
	}
	n, err := t.q.UpdateTask(ctx, dbgen.UpdateTaskParams{
		Status:          string(task.Status),
		TerminalReason:  task.TerminalReason,
		RestartCount:    int64(task.RestartCount),
		RestartLimit:    int64(task.RestartLimit),
		PhaseName:       task.PhaseName,
		CheckpointJson:  string(task.CheckpointJSON),
		WakeUntilMs:     task.WakeUntilMs,
		WaitMode:        string(task.WaitMode),
		WaitTaskIdsJson: string(waitIDsJSON),
		WaitSignalName:  task.WaitSignalName,
		MemoJson:        string(task.MemoJSON),
		ResultJson:      string(task.ResultJSON),
		ErrorText:       task.ErrorText,
		UpdatedAtMs:     task.UpdatedAtMs,
		ID:              task.ID,
	})
	if err != nil {
		return classifySQLiteErr(err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (t *sqliteTx) insertSignal(ctx context.Context, sig Signal) error {
	seqOrder := t.backend.nextSigOrder.Add(1)
	err := t.q.InsertSignal(ctx, dbgen.InsertSignalParams{
		ID:           sig.ID,
		InsertSeq:    seqOrder,
		TaskID:       sig.TaskID,
		SignalName:   sig.SignalName,
		SignalKey:    sig.SignalKey,
		PayloadJson:  string(sig.PayloadJSON),
		Consumed:     int64(boolToInt(sig.Consumed)),
		ConsumedAtMs: sig.ConsumedAtMs,
		CreatedAtMs:  sig.CreatedAtMs,
	})
	return classifySQLiteErr(err)
}

func (t *sqliteTx) getSignalByKey(ctx context.Context, taskID, signalName, signalKey string) (Signal, bool, error) {
	if signalKey == "" {
		return Signal{}, false, nil
	}
	row, err := t.q.GetSignalByKey(ctx, dbgen.GetSignalByKeyParams{
		TaskID:     taskID,
		SignalName: signalName,
		SignalKey:  signalKey,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Signal{}, false, nil
	}
	if err != nil {
		return Signal{}, false, err
	}
	return Signal{
		ID:           row.ID,
		TaskID:       row.TaskID,
		SignalName:   row.SignalName,
		SignalKey:    row.SignalKey,
		PayloadJSON:  []byte(row.PayloadJson),
		Consumed:     row.Consumed != 0,
		ConsumedAtMs: row.ConsumedAtMs,
		CreatedAtMs:  row.CreatedAtMs,
	}, true, nil
}

func (t *sqliteTx) markSignalConsumed(ctx context.Context, signalID string, consumedAtMs int64) error {
	n, err := t.q.MarkSignalConsumed(ctx, dbgen.MarkSignalConsumedParams{
		ConsumedAtMs: consumedAtMs,
		ID:           signalID,
	})
	if err != nil {
		return classifySQLiteErr(err)
	}
	if n == 0 {
		_, err2 := t.q.SignalExists(ctx, signalID)
		if errors.Is(err2, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err2 != nil {
			return classifySQLiteErr(err2)
		}
		return ErrConflict
	}
	return nil
}

func convFromModel(m dbgen.DurableConversation) Conversation {
	return Conversation{
		ID:               m.ID,
		OwnerTaskID:      m.OwnerTaskID,
		ParentID:         m.ParentID,
		ForkEntrySeq:     m.ForkEntrySeq,
		HeadSeq:          m.HeadSeq,
		NextSeq:          m.NextSeq,
		ProviderAffinity: m.ProviderAffinity,
		MetadataJSON:     []byte(m.MetadataJson),
		CreatedAtMs:      m.CreatedAtMs,
		UpdatedAtMs:      m.UpdatedAtMs,
	}
}

func sqlGetConversation(ctx context.Context, q *dbgen.Queries, id string) (Conversation, bool, error) {
	m, err := q.GetConversation(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, false, nil
	}
	if err != nil {
		return Conversation{}, false, err
	}
	return convFromModel(m), true, nil
}

func sqlListConversationsByOwnerTask(ctx context.Context, q *dbgen.Queries, ownerTaskID string) ([]Conversation, error) {
	rows, err := q.ListConversationsByOwnerTask(ctx, ownerTaskID)
	if err != nil {
		return nil, err
	}
	var out []Conversation
	for _, m := range rows {
		out = append(out, convFromModel(m))
	}
	return out, nil
}

func sqlListEntries(ctx context.Context, q *dbgen.Queries, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	var rows []dbgen.DurableEntry
	var err error
	if maxSeq > 0 {
		rows, err = q.ListEntriesRange(ctx, dbgen.ListEntriesRangeParams{
			ConversationID: conversationID,
			Seq:            fromSeq,
			Seq_2:          maxSeq,
		})
	} else {
		rows, err = q.ListEntriesFrom(ctx, dbgen.ListEntriesFromParams{
			ConversationID: conversationID,
			Seq:            fromSeq,
		})
	}
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, m := range rows {
		out = append(out, Entry{
			ConversationID: m.ConversationID,
			Seq:            m.Seq,
			Kind:           m.Kind,
			PayloadJSON:    []byte(m.PayloadJson),
			CreatedAtMs:    m.CreatedAtMs,
		})
	}
	return out, nil
}

func docFromModel(m dbgen.DurableDocument) Document {
	return Document{
		ScopeKind:   m.ScopeKind,
		ScopeID:     m.ScopeID,
		DocKind:     m.DocKind,
		Rev:         m.Rev,
		StateJSON:   []byte(m.StateJson),
		UpdatedAtMs: m.UpdatedAtMs,
	}
}

func sqlGetDocument(ctx context.Context, q *dbgen.Queries, key DocKey) (Document, bool, error) {
	m, err := q.GetDocument(ctx, dbgen.GetDocumentParams{
		ScopeKind: key.ScopeKind,
		ScopeID:   key.ScopeID,
		DocKind:   key.DocKind,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Document{}, false, nil
	}
	if err != nil {
		return Document{}, false, err
	}
	return docFromModel(m), true, nil
}

func sqlListDocumentsByScope(ctx context.Context, q *dbgen.Queries, scopeKind, scopeID string) ([]Document, error) {
	rows, err := q.ListDocumentsByScope(ctx, dbgen.ListDocumentsByScopeParams{
		ScopeKind: scopeKind,
		ScopeID:   scopeID,
	})
	if err != nil {
		return nil, err
	}
	var out []Document
	for _, m := range rows {
		out = append(out, docFromModel(m))
	}
	return out, nil
}

func submissionFromModel(m dbgen.DurableSubmission) Submission {
	return Submission{
		ID:             m.ID,
		ConversationID: m.ConversationID,
		RequestID:      m.RequestID,
		Kind:           m.Kind,
		Status:         m.Status,
		PayloadJSON:    []byte(m.PayloadJson),
		NotifyTaskID:   m.NotifyTaskID,
		ResultJSON:     []byte(m.ResultJson),
		CreatedAtMs:    m.CreatedAtMs,
		UpdatedAtMs:    m.UpdatedAtMs,
	}
}

func sqlGetSubmission(ctx context.Context, q *dbgen.Queries, id string) (Submission, bool, error) {
	m, err := q.GetSubmission(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Submission{}, false, nil
	}
	if err != nil {
		return Submission{}, false, err
	}
	return submissionFromModel(m), true, nil
}

func sqlGetSubmissionByRequestID(ctx context.Context, q *dbgen.Queries, conversationID, requestID string) (Submission, bool, error) {
	m, err := q.GetSubmissionByRequestID(ctx, dbgen.GetSubmissionByRequestIDParams{
		ConversationID: conversationID,
		RequestID:      requestID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Submission{}, false, nil
	}
	if err != nil {
		return Submission{}, false, err
	}
	return submissionFromModel(m), true, nil
}

func taskFromModel(m dbgen.DurableTask) (Task, error) {
	t := Task{
		ID:             m.ID,
		ConversationID: m.ConversationID,
		OwnerTaskID:    m.OwnerTaskID,
		DedupKey:       m.DedupKey,
		Kind:           m.Kind,
		IsModelTask:    m.IsModelTask != 0,
		Status:         TaskStatus(m.Status),
		TerminalReason: m.TerminalReason,
		RestartCount:   int(m.RestartCount),
		RestartLimit:   int(m.RestartLimit),
		PhaseName:      m.PhaseName,
		CheckpointJSON: []byte(m.CheckpointJson),
		WakeUntilMs:    m.WakeUntilMs,
		WaitMode:       WaitMode(m.WaitMode),
		WaitSignalName: m.WaitSignalName,
		MemoJSON:       []byte(m.MemoJson),
		ResultJSON:     []byte(m.ResultJson),
		ErrorText:      m.ErrorText,
		CreatedAtMs:    m.CreatedAtMs,
		UpdatedAtMs:    m.UpdatedAtMs,
	}
	if m.WaitTaskIdsJson != "" {
		var ids []string
		if err := json.Unmarshal([]byte(m.WaitTaskIdsJson), &ids); err != nil {
			return Task{}, err
		}
		if len(ids) > 0 {
			t.WaitTaskIDs = ids
		}
	}
	return t, nil
}

func tasksFromModels(rows []dbgen.DurableTask) ([]Task, error) {
	var out []Task
	for _, m := range rows {
		t, err := taskFromModel(m)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func sqlGetTask(ctx context.Context, q *dbgen.Queries, id string) (Task, bool, error) {
	m, err := q.GetTask(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, err
	}
	t, err := taskFromModel(m)
	if err != nil {
		return Task{}, false, err
	}
	return t, true, nil
}

func sqlGetTaskByDedupKey(ctx context.Context, q *dbgen.Queries, ownerTaskID, dedupKey string) (Task, bool, error) {
	if dedupKey == "" {
		return Task{}, false, nil
	}
	m, err := q.GetTaskByDedupKey(ctx, dbgen.GetTaskByDedupKeyParams{
		OwnerTaskID: ownerTaskID,
		DedupKey:    dedupKey,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return Task{}, false, nil
	}
	if err != nil {
		return Task{}, false, err
	}
	t, err := taskFromModel(m)
	if err != nil {
		return Task{}, false, err
	}
	return t, true, nil
}

func sqlListTasksByOwner(ctx context.Context, q *dbgen.Queries, ownerTaskID string) ([]Task, error) {
	rows, err := q.ListTasksByOwner(ctx, ownerTaskID)
	if err != nil {
		return nil, err
	}
	return tasksFromModels(rows)
}

func sqlListTasksByStatus(ctx context.Context, q *dbgen.Queries, statuses []TaskStatus) ([]Task, error) {
	var rows []dbgen.DurableTask
	var err error
	if len(statuses) == 0 {
		rows, err = q.ListAllTasks(ctx)
	} else {
		strStatuses := make([]string, len(statuses))
		for i, st := range statuses {
			strStatuses[i] = string(st)
		}
		rows, err = q.ListTasksByStatus(ctx, strStatuses)
	}
	if err != nil {
		return nil, err
	}
	return tasksFromModels(rows)
}

func sqlListTasksByConversation(ctx context.Context, q *dbgen.Queries, conversationID string) ([]Task, error) {
	rows, err := q.ListTasksByConversation(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	return tasksFromModels(rows)
}

func sqlListSignals(ctx context.Context, q *dbgen.Queries, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	var onlyUncons int64
	if onlyUnconsumed {
		onlyUncons = 1
	}
	rows, err := q.ListSignals(ctx, dbgen.ListSignalsParams{
		TaskID:         taskID,
		SignalName:     signalName,
		OnlyUnconsumed: onlyUncons,
	})
	if err != nil {
		return nil, err
	}
	var out []Signal
	for _, r := range rows {
		out = append(out, Signal{
			ID:           r.ID,
			TaskID:       r.TaskID,
			SignalName:   r.SignalName,
			SignalKey:    r.SignalKey,
			PayloadJSON:  []byte(r.PayloadJson),
			Consumed:     r.Consumed != 0,
			ConsumedAtMs: r.ConsumedAtMs,
			CreatedAtMs:  r.CreatedAtMs,
		})
	}
	return out, nil
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
