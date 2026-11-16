package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync/atomic"
)

// backend defines the raw transactional persistence primitives shared across memory and SQL backends.
type backend interface {
	beginTx(ctx context.Context) (backendTx, error)
	read(ctx context.Context) backendReader
	close() error
}

// backendReader provides snapshot-consistent reads outside of a write transaction.
type backendReader interface {
	getConversation(ctx context.Context, id string) (Conversation, bool, error)
	listConversationsByOwnerTask(ctx context.Context, ownerTaskID string) ([]Conversation, error)
	listEntries(ctx context.Context, conversationID string, fromSeq, maxSeq int64) ([]Entry, error)
	getDocument(ctx context.Context, key DocKey) (Document, bool, error)
	listDocumentsByScope(ctx context.Context, scopeKind, scopeID string) ([]Document, error)
	getSubmission(ctx context.Context, id string) (Submission, bool, error)
	getSubmissionByRequestID(ctx context.Context, conversationID, requestID string) (Submission, bool, error)
	getTask(ctx context.Context, id string) (Task, bool, error)
	getTaskByDedupKey(ctx context.Context, ownerTaskID, dedupKey string) (Task, bool, error)
	listTasksByOwner(ctx context.Context, ownerTaskID string) ([]Task, error)
	listTasksByStatus(ctx context.Context, statuses []TaskStatus) ([]Task, error)
	listTasksByConversation(ctx context.Context, conversationID string) ([]Task, error)
	listSignals(ctx context.Context, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error)
}

// backendTx is a single-writer transaction supporting savepoints for per-item Group Commit isolation.
type backendTx interface {
	backendReader
	savepoint(ctx context.Context, name string) error
	rollbackToSavepoint(ctx context.Context, name string) error
	releaseSavepoint(ctx context.Context, name string) error
	commit(ctx context.Context) error
	rollback() error

	insertConversation(ctx context.Context, conv Conversation) error
	updateConversation(ctx context.Context, conv Conversation) error

	insertEntry(ctx context.Context, entry Entry) error

	upsertDocument(ctx context.Context, doc Document) (Document, error)
	deleteDocument(ctx context.Context, key DocKey) (bool, error)

	insertSubmission(ctx context.Context, sub Submission) error
	updateSubmission(ctx context.Context, sub Submission) error

	insertTask(ctx context.Context, task Task) error
	updateTask(ctx context.Context, task Task) error

	insertSignal(ctx context.Context, sig Signal) error
	getSignalByKey(ctx context.Context, taskID, signalName, signalKey string) (Signal, bool, error)
	markSignalConsumed(ctx context.Context, signalID string, consumedAtMs int64) error
}

var idFallbackSeq atomic.Uint64

// NewUUIDv7 returns a RFC 9562 time-ordered UUIDv7 string using timestampMs.
func NewUUIDv7(timestampMs int64) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		n := idFallbackSeq.Add(1)
		b[6] = byte(n >> 8)
		b[7] = byte(n)
	}
	ms := uint64(timestampMs)
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)

	// Version 7 (0111) and RFC 4122/9562 variant (10xx).
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80

	var dst [36]byte
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst[:])
}

func cloneConversation(c Conversation) Conversation {
	c.MetadataJSON = cloneBytes(c.MetadataJSON)
	return c
}

func cloneEntry(e Entry) Entry {
	e.PayloadJSON = cloneBytes(e.PayloadJSON)
	return e
}

func cloneDocument(d Document) Document {
	d.StateJSON = cloneBytes(d.StateJSON)
	return d
}

func cloneSubmission(s Submission) Submission {
	s.PayloadJSON = cloneBytes(s.PayloadJSON)
	s.ResultJSON = cloneBytes(s.ResultJSON)
	return s
}

func cloneTask(t Task) Task {
	t.CheckpointJSON = cloneBytes(t.CheckpointJSON)
	t.MemoJSON = cloneBytes(t.MemoJSON)
	t.ResultJSON = cloneBytes(t.ResultJSON)
	if t.WaitTaskIDs != nil {
		cp := make([]string, len(t.WaitTaskIDs))
		copy(cp, t.WaitTaskIDs)
		t.WaitTaskIDs = cp
	}
	return t
}

func cloneSignal(s Signal) Signal {
	s.PayloadJSON = cloneBytes(s.PayloadJSON)
	return s
}

func formatSavepointName(idx int) string {
	return fmt.Sprintf("sp_%d", idx)
}
