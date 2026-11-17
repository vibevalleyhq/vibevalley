package store

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
)

// Tx exposes atomic multi-table operations inside a single Group Commit batch transaction.
// Any DocumentEvent emitted within Tx is buffered and published ONLY after the underlying
// database transaction successfully commits.
type Tx struct {
	btx       backendTx
	nowMs     int64
	docEvents []DocumentEvent
}

// NowMs returns the transaction's virtual/wall timestamp in milliseconds.
func (tx *Tx) NowMs() int64 { return tx.nowMs }

// CreateConversation inserts a new durable_conversation row.
func (tx *Tx) CreateConversation(ctx context.Context, conv Conversation) (Conversation, error) {
	if conv.ID == "" {
		conv.ID = NewUUIDv7(tx.nowMs)
	}
	meta, err := requireJSON(conv.MetadataJSON, "{}")
	if err != nil {
		return Conversation{}, fmt.Errorf("%w: metadataJson: %v", ErrInvalidArgument, err)
	}
	conv.MetadataJSON = meta
	if conv.HeadSeq <= 0 {
		conv.HeadSeq = 1
	}
	if conv.NextSeq <= 0 {
		conv.NextSeq = 1
	}
	if conv.CreatedAtMs == 0 {
		conv.CreatedAtMs = tx.nowMs
	}
	if conv.UpdatedAtMs == 0 {
		conv.UpdatedAtMs = conv.CreatedAtMs
	}
	if err := tx.btx.insertConversation(ctx, conv); err != nil {
		return Conversation{}, err
	}
	return cloneConversation(conv), nil
}

// ForkConversation creates a child conversation forked from parentID at forkEntrySeq,
// inheriting providerAffinity unless overridden (which is normally kept fixed).
func (tx *Tx) ForkConversation(ctx context.Context, parentID, childID, ownerTaskID, providerAffinity string, forkEntrySeq int64) (Conversation, error) {
	parent, ok, err := tx.btx.getConversation(ctx, parentID)
	if err != nil {
		return Conversation{}, err
	}
	if !ok {
		return Conversation{}, fmt.Errorf("%w: parent conversation %q", ErrNotFound, parentID)
	}
	if forkEntrySeq < 0 || forkEntrySeq >= parent.NextSeq {
		return Conversation{}, fmt.Errorf("%w: forkEntrySeq %d out of bounds [0, %d)", ErrInvalidArgument, forkEntrySeq, parent.NextSeq)
	}
	if providerAffinity == "" {
		providerAffinity = parent.ProviderAffinity
	}
	headSeq := int64(1)
	if forkEntrySeq >= parent.HeadSeq-1 && parent.HeadSeq > 1 {
		headSeq = parent.HeadSeq
	}
	child := Conversation{
		ID:               childID,
		OwnerTaskID:      ownerTaskID,
		ParentID:         parentID,
		ForkEntrySeq:     forkEntrySeq,
		HeadSeq:          headSeq,
		NextSeq:          forkEntrySeq + 1,
		ProviderAffinity: providerAffinity,
		MetadataJSON:     []byte("{}"),
		CreatedAtMs:      tx.nowMs,
		UpdatedAtMs:      tx.nowMs,
	}
	return tx.CreateConversation(ctx, child)
}

func (tx *Tx) GetConversation(ctx context.Context, id string) (Conversation, error) {
	c, ok, err := tx.btx.getConversation(ctx, id)
	if err != nil {
		return Conversation{}, err
	}
	if !ok {
		return Conversation{}, fmt.Errorf("%w: conversation %q", ErrNotFound, id)
	}
	return c, nil
}

func (tx *Tx) ListConversationsByOwnerTask(ctx context.Context, ownerTaskID string) ([]Conversation, error) {
	return tx.btx.listConversationsByOwnerTask(ctx, ownerTaskID)
}

// AppendEntry appends an immutable ledger row at the conversation's next monotonic seq.
func (tx *Tx) AppendEntry(ctx context.Context, conversationID, kind string, payloadJSON []byte) (Entry, error) {
	if kind == "" {
		return Entry{}, fmt.Errorf("%w: empty entry kind", ErrInvalidArgument)
	}
	payload, err := requireJSON(payloadJSON, "{}")
	if err != nil {
		return Entry{}, fmt.Errorf("%w: entry payloadJson: %v", ErrInvalidArgument, err)
	}
	conv, ok, err := tx.btx.getConversation(ctx, conversationID)
	if err != nil {
		return Entry{}, err
	}
	if !ok {
		return Entry{}, fmt.Errorf("%w: conversation %q", ErrNotFound, conversationID)
	}
	seq := conv.NextSeq
	conv.NextSeq = seq + 1
	conv.UpdatedAtMs = tx.nowMs
	if err := tx.btx.updateConversation(ctx, conv); err != nil {
		return Entry{}, err
	}
	entry := Entry{
		ConversationID: conversationID,
		Seq:            seq,
		Kind:           kind,
		PayloadJSON:    payload,
		CreatedAtMs:    tx.nowMs,
	}
	if err := tx.btx.insertEntry(ctx, entry); err != nil {
		return Entry{}, err
	}
	return cloneEntry(entry), nil
}

func (tx *Tx) GetEntries(ctx context.Context, conversationID string, fromSeq int64) ([]Entry, error) {
	if fromSeq < 1 {
		fromSeq = 1
	}
	return tx.btx.listEntries(ctx, conversationID, fromSeq, 0)
}

func (tx *Tx) GetVisibleEntries(ctx context.Context, conversationID string) ([]Entry, error) {
	return loadVisibleEntries(ctx, tx.btx, conversationID)
}

// CommitCompaction atomically checks whether the compaction cutpoint is still valid and
// appends a pi.compaction entry while advancing head_seq without mutating historical entries.
// Concurrent compactions that fall behind an already committed cutpoint or reset are discarded as stale.
func (tx *Tx) CommitCompaction(ctx context.Context, req CompactionCommit) (CompactionOutcome, error) {
	conv, ok, err := tx.btx.getConversation(ctx, req.ConversationID)
	if err != nil {
		return CompactionOutcome{}, err
	}
	if !ok {
		return CompactionOutcome{}, fmt.Errorf("%w: conversation %q", ErrNotFound, req.ConversationID)
	}
	if req.CutSeq < 1 || req.CutSeq >= conv.NextSeq {
		return CompactionOutcome{}, fmt.Errorf("%w: cutSeq %d out of bounds [1, %d)", ErrInvalidArgument, req.CutSeq, conv.NextSeq)
	}

	// Stale detection: if head_seq already moved past BaseHeadSeq or CutSeq, or a newer compaction/reset landed, discard.
	if (req.BaseHeadSeq > 0 && conv.HeadSeq > req.BaseHeadSeq) || req.CutSeq < conv.HeadSeq {
		return CompactionOutcome{Applied: false, Stale: true}, nil
	}
	existing, err := tx.btx.listEntries(ctx, req.ConversationID, 1, 0)
	if err != nil {
		return CompactionOutcome{}, err
	}
	for _, e := range existing {
		if e.Kind == EntryReset && req.BaseHeadSeq > 0 && e.Seq >= req.BaseHeadSeq {
			return CompactionOutcome{Applied: false, Stale: true}, nil
		}
		if e.Kind == EntryCompaction {
			var p CompactionPayload
			if json.Unmarshal(e.PayloadJSON, &p) == nil && p.CutSeq >= req.CutSeq {
				return CompactionOutcome{Applied: false, Stale: true}, nil
			}
		}
	}

	payloadBytes, err := json.Marshal(CompactionPayload{
		Level:       req.Level,
		BaseHeadSeq: req.BaseHeadSeq,
		FromSeq:     req.FromSeq,
		CutSeq:      req.CutSeq,
		Summary:     req.Summary,
		TokenCount:  req.TokenCount,
	})
	if err != nil {
		return CompactionOutcome{}, err
	}

	seq := conv.NextSeq
	conv.NextSeq = seq + 1
	conv.HeadSeq = req.CutSeq + 1
	conv.UpdatedAtMs = tx.nowMs
	if err := tx.btx.updateConversation(ctx, conv); err != nil {
		return CompactionOutcome{}, err
	}

	entry := Entry{
		ConversationID: req.ConversationID,
		Seq:            seq,
		Kind:           EntryCompaction,
		PayloadJSON:    payloadBytes,
		CreatedAtMs:    tx.nowMs,
	}
	if err := tx.btx.insertEntry(ctx, entry); err != nil {
		return CompactionOutcome{}, err
	}
	return CompactionOutcome{
		Applied:    true,
		Stale:      false,
		EntrySeq:   seq,
		NewHeadSeq: conv.HeadSeq,
	}, nil
}

// AppendReset appends a pi.reset entry and advances head_seq past the reset marker.
func (tx *Tx) AppendReset(ctx context.Context, conversationID string, payloadJSON []byte) (Entry, error) {
	payload, err := requireJSON(payloadJSON, "{}")
	if err != nil {
		return Entry{}, fmt.Errorf("%w: reset payloadJson: %v", ErrInvalidArgument, err)
	}
	conv, ok, err := tx.btx.getConversation(ctx, conversationID)
	if err != nil {
		return Entry{}, err
	}
	if !ok {
		return Entry{}, fmt.Errorf("%w: conversation %q", ErrNotFound, conversationID)
	}
	seq := conv.NextSeq
	conv.NextSeq = seq + 1
	conv.HeadSeq = seq + 1
	conv.UpdatedAtMs = tx.nowMs
	if err := tx.btx.updateConversation(ctx, conv); err != nil {
		return Entry{}, err
	}
	entry := Entry{
		ConversationID: conversationID,
		Seq:            seq,
		Kind:           EntryReset,
		PayloadJSON:    payload,
		CreatedAtMs:    tx.nowMs,
	}
	if err := tx.btx.insertEntry(ctx, entry); err != nil {
		return Entry{}, err
	}
	return cloneEntry(entry), nil
}

// PutDocument upserts a durable_document row and buffers a Durable DocumentEvent for post-commit delivery.
func (tx *Tx) PutDocument(ctx context.Context, scopeKind, scopeID, docKind string, stateJSON []byte) (Document, error) {
	if scopeKind == "" || scopeID == "" || docKind == "" {
		return Document{}, fmt.Errorf("%w: document key must be non-empty", ErrInvalidArgument)
	}
	state, err := requireJSON(stateJSON, "{}")
	if err != nil {
		return Document{}, fmt.Errorf("%w: document stateJson: %v", ErrInvalidArgument, err)
	}
	doc, err := tx.btx.upsertDocument(ctx, Document{
		ScopeKind:   scopeKind,
		ScopeID:     scopeID,
		DocKind:     docKind,
		StateJSON:   state,
		UpdatedAtMs: tx.nowMs,
	})
	if err != nil {
		return Document{}, err
	}
	tx.docEvents = append(tx.docEvents, DocumentEvent{
		ScopeKind:   doc.ScopeKind,
		ScopeID:     doc.ScopeID,
		DocKind:     doc.DocKind,
		Rev:         doc.Rev,
		StateJSON:   cloneBytes(doc.StateJSON),
		Durable:     true,
		UpdatedAtMs: doc.UpdatedAtMs,
	})
	return doc, nil
}

func (tx *Tx) GetDocument(ctx context.Context, scopeKind, scopeID, docKind string) (Document, error) {
	doc, ok, err := tx.btx.getDocument(ctx, DocKey{ScopeKind: scopeKind, ScopeID: scopeID, DocKind: docKind})
	if err != nil {
		return Document{}, err
	}
	if !ok {
		return Document{}, fmt.Errorf("%w: document (%s,%s,%s)", ErrNotFound, scopeKind, scopeID, docKind)
	}
	return doc, nil
}

func (tx *Tx) DeleteDocument(ctx context.Context, scopeKind, scopeID, docKind string) error {
	key := DocKey{ScopeKind: scopeKind, ScopeID: scopeID, DocKind: docKind}
	existing, found, err := tx.btx.getDocument(ctx, key)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	deleted, err := tx.btx.deleteDocument(ctx, key)
	if err != nil {
		return err
	}
	if deleted {
		tx.docEvents = append(tx.docEvents, DocumentEvent{
			ScopeKind:   scopeKind,
			ScopeID:     scopeID,
			DocKind:     docKind,
			Rev:         existing.Rev,
			StateJSON:   cloneBytes(existing.StateJSON),
			Retired:     true,
			Durable:     true,
			UpdatedAtMs: tx.nowMs,
		})
	}
	return nil
}

// Submit inserts a submission idempotently by (conversation_id, request_id).
func (tx *Tx) Submit(ctx context.Context, sub Submission) (SubmitResult, error) {
	if sub.ConversationID == "" || sub.RequestID == "" {
		return SubmitResult{}, fmt.Errorf("%w: conversationId and requestId required", ErrInvalidArgument)
	}
	existing, ok, err := tx.btx.getSubmissionByRequestID(ctx, sub.ConversationID, sub.RequestID)
	if err != nil {
		return SubmitResult{}, err
	}
	if ok {
		return SubmitResult{Submission: existing, Deduplicated: true}, nil
	}
	payload, err := requireJSON(sub.PayloadJSON, "{}")
	if err != nil {
		return SubmitResult{}, fmt.Errorf("%w: submission payloadJson: %v", ErrInvalidArgument, err)
	}
	resJSON, err := requireJSON(sub.ResultJSON, "{}")
	if err != nil {
		return SubmitResult{}, fmt.Errorf("%w: submission resultJson: %v", ErrInvalidArgument, err)
	}
	if sub.ID == "" {
		sub.ID = NewUUIDv7(tx.nowMs)
	}
	if sub.Status == "" {
		sub.Status = SubmissionQueued
	}
	if sub.Kind == "" {
		sub.Kind = "prompt"
	}
	sub.PayloadJSON = payload
	sub.ResultJSON = resJSON
	if sub.CreatedAtMs == 0 {
		sub.CreatedAtMs = tx.nowMs
	}
	if sub.UpdatedAtMs == 0 {
		sub.UpdatedAtMs = sub.CreatedAtMs
	}
	if err := tx.btx.insertSubmission(ctx, sub); err != nil {
		return SubmitResult{}, err
	}
	return SubmitResult{Submission: cloneSubmission(sub), Deduplicated: false}, nil
}

func (tx *Tx) UpdateSubmissionStatus(ctx context.Context, id, status string) (Submission, error) {
	sub, ok, err := tx.btx.getSubmission(ctx, id)
	if err != nil {
		return Submission{}, err
	}
	if !ok {
		return Submission{}, fmt.Errorf("%w: submission %q", ErrNotFound, id)
	}
	sub.Status = status
	sub.UpdatedAtMs = tx.nowMs
	if err := tx.btx.updateSubmission(ctx, sub); err != nil {
		return Submission{}, err
	}
	return sub, nil
}

// SettleSubmission moves a submission to done/unanswered and atomically buffers a pi.submission_settled
// signal on NotifyTaskID if configured.
func (tx *Tx) SettleSubmission(ctx context.Context, id, status string, resultJSON []byte) (Submission, error) {
	if status != SubmissionDone && status != SubmissionUnanswered {
		return Submission{}, fmt.Errorf("%w: invalid terminal submission status %q", ErrInvalidArgument, status)
	}
	resBytes, err := requireJSON(resultJSON, "{}")
	if err != nil {
		return Submission{}, fmt.Errorf("%w: resultJson: %v", ErrInvalidArgument, err)
	}
	sub, ok, err := tx.btx.getSubmission(ctx, id)
	if err != nil {
		return Submission{}, err
	}
	if !ok {
		return Submission{}, fmt.Errorf("%w: submission %q", ErrNotFound, id)
	}
	sub.Status = status
	sub.ResultJSON = resBytes
	sub.UpdatedAtMs = tx.nowMs
	if err := tx.btx.updateSubmission(ctx, sub); err != nil {
		return Submission{}, err
	}
	if sub.NotifyTaskID != "" {
		sigPayload, err := json.Marshal(map[string]any{
			"submissionId":   sub.ID,
			"conversationId": sub.ConversationID,
			"requestId":      sub.RequestID,
			"status":         sub.Status,
			"result":         json.RawMessage(resBytes),
		})
		if err != nil {
			return Submission{}, err
		}
		if _, err := tx.SendSignal(ctx, Signal{
			TaskID:      sub.NotifyTaskID,
			SignalName:  SignalSubmissionSettled,
			SignalKey:   sub.ID,
			PayloadJSON: sigPayload,
		}); err != nil {
			return Submission{}, err
		}
	}
	return sub, nil
}

func (tx *Tx) GetSubmission(ctx context.Context, id string) (Submission, error) {
	sub, ok, err := tx.btx.getSubmission(ctx, id)
	if err != nil {
		return Submission{}, err
	}
	if !ok {
		return Submission{}, fmt.Errorf("%w: submission %q", ErrNotFound, id)
	}
	return sub, nil
}

func (tx *Tx) GetSubmissionByRequestID(ctx context.Context, conversationID, requestID string) (Submission, error) {
	sub, ok, err := tx.btx.getSubmissionByRequestID(ctx, conversationID, requestID)
	if err != nil {
		return Submission{}, err
	}
	if !ok {
		return Submission{}, fmt.Errorf("%w: submission (%s,%s)", ErrNotFound, conversationID, requestID)
	}
	return sub, nil
}

// CreateTask creates a durable_task, deduplicating by (owner_task_id, dedup_key) when dedupKey is non-empty.
func (tx *Tx) CreateTask(ctx context.Context, task Task) (CreateTaskResult, error) {
	if task.Kind == "" {
		return CreateTaskResult{}, fmt.Errorf("%w: task kind required", ErrInvalidArgument)
	}
	if task.DedupKey != "" {
		existing, ok, err := tx.btx.getTaskByDedupKey(ctx, task.OwnerTaskID, task.DedupKey)
		if err != nil {
			return CreateTaskResult{}, err
		}
		if ok {
			return CreateTaskResult{Task: existing, Deduplicated: true}, nil
		}
	}
	cp, err := requireJSON(task.CheckpointJSON, "{}")
	if err != nil {
		return CreateTaskResult{}, fmt.Errorf("%w: checkpointJson: %v", ErrInvalidArgument, err)
	}
	memo, err := requireJSON(task.MemoJSON, "{}")
	if err != nil {
		return CreateTaskResult{}, fmt.Errorf("%w: memoJson: %v", ErrInvalidArgument, err)
	}
	resJSON, err := requireJSON(task.ResultJSON, "{}")
	if err != nil {
		return CreateTaskResult{}, fmt.Errorf("%w: resultJson: %v", ErrInvalidArgument, err)
	}
	if task.ID == "" {
		task.ID = NewUUIDv7(tx.nowMs)
	}
	if task.Status == "" {
		task.Status = TaskPending
	}
	if task.RestartLimit <= 0 {
		task.RestartLimit = 5
	}
	task.CheckpointJSON = cp
	task.MemoJSON = memo
	task.ResultJSON = resJSON
	if task.CreatedAtMs == 0 {
		task.CreatedAtMs = tx.nowMs
	}
	if task.UpdatedAtMs == 0 {
		task.UpdatedAtMs = task.CreatedAtMs
	}
	if err := tx.btx.insertTask(ctx, task); err != nil {
		return CreateTaskResult{}, err
	}
	return CreateTaskResult{Task: cloneTask(task), Deduplicated: false}, nil
}

func (tx *Tx) GetTask(ctx context.Context, id string) (Task, error) {
	t, ok, err := tx.btx.getTask(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if !ok {
		return Task{}, fmt.Errorf("%w: task %q", ErrNotFound, id)
	}
	return t, nil
}

func (tx *Tx) GetTaskByDedupKey(ctx context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	return tx.btx.getTaskByDedupKey(ctx, ownerTaskID, dedupKey)
}

func (tx *Tx) UpdateTask(ctx context.Context, task Task) (Task, error) {
	cp, err := requireJSON(task.CheckpointJSON, "{}")
	if err != nil {
		return Task{}, fmt.Errorf("%w: checkpointJson: %v", ErrInvalidArgument, err)
	}
	memo, err := requireJSON(task.MemoJSON, "{}")
	if err != nil {
		return Task{}, fmt.Errorf("%w: memoJson: %v", ErrInvalidArgument, err)
	}
	resJSON, err := requireJSON(task.ResultJSON, "{}")
	if err != nil {
		return Task{}, fmt.Errorf("%w: resultJson: %v", ErrInvalidArgument, err)
	}
	task.CheckpointJSON = cp
	task.MemoJSON = memo
	task.ResultJSON = resJSON
	task.UpdatedAtMs = tx.nowMs
	if err := tx.btx.updateTask(ctx, task); err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (tx *Tx) ListChildTasks(ctx context.Context, ownerTaskID string) ([]Task, error) {
	return tx.btx.listTasksByOwner(ctx, ownerTaskID)
}

func (tx *Tx) ListTasksByStatus(ctx context.Context, statuses ...TaskStatus) ([]Task, error) {
	return tx.btx.listTasksByStatus(ctx, statuses)
}

func (tx *Tx) ListTasksByConversation(ctx context.Context, conversationID string) ([]Task, error) {
	return tx.btx.listTasksByConversation(ctx, conversationID)
}

// SendSignal persists a signal (deduplicating when signalKey is non-empty) for early-signal
// buffering or immediate wakeup.
func (tx *Tx) SendSignal(ctx context.Context, sig Signal) (SendSignalResult, error) {
	if sig.TaskID == "" || sig.SignalName == "" {
		return SendSignalResult{}, fmt.Errorf("%w: taskId and signalName required", ErrInvalidArgument)
	}
	if sig.SignalKey != "" {
		existing, ok, err := tx.btx.getSignalByKey(ctx, sig.TaskID, sig.SignalName, sig.SignalKey)
		if err != nil {
			return SendSignalResult{}, err
		}
		if ok {
			return SendSignalResult{Signal: existing, Deduplicated: true}, nil
		}
	}
	payload, err := requireJSON(sig.PayloadJSON, "{}")
	if err != nil {
		return SendSignalResult{}, fmt.Errorf("%w: signal payloadJson: %v", ErrInvalidArgument, err)
	}
	if sig.ID == "" {
		sig.ID = NewUUIDv7(tx.nowMs)
	}
	sig.PayloadJSON = payload
	if sig.CreatedAtMs == 0 {
		sig.CreatedAtMs = tx.nowMs
	}
	if err := tx.btx.insertSignal(ctx, sig); err != nil {
		return SendSignalResult{}, err
	}
	return SendSignalResult{Signal: cloneSignal(sig), Deduplicated: false}, nil
}

// ConsumeFirstSignal pops the oldest unconsumed signal matching (taskID, signalName) exact-once.
func (tx *Tx) ConsumeFirstSignal(ctx context.Context, taskID, signalName string) (Signal, bool, error) {
	pending, err := tx.btx.listSignals(ctx, taskID, signalName, true)
	if err != nil {
		return Signal{}, false, err
	}
	if len(pending) == 0 {
		return Signal{}, false, nil
	}
	first := pending[0]
	if err := tx.btx.markSignalConsumed(ctx, first.ID, tx.nowMs); err != nil {
		return Signal{}, false, err
	}
	first.Consumed = true
	first.ConsumedAtMs = tx.nowMs
	return first, true, nil
}

func (tx *Tx) ListSignals(ctx context.Context, taskID string, includeConsumed bool) ([]Signal, error) {
	return tx.btx.listSignals(ctx, taskID, "", !includeConsumed)
}

func loadVisibleEntries(ctx context.Context, r backendReader, conversationID string) ([]Entry, error) {
	type segment struct {
		conv    Conversation
		entries []Entry
	}

	var chain []segment
	seen := make(map[string]bool)
	curID := conversationID
	var maxSeq int64 = 0

	for curID != "" {
		if seen[curID] {
			return nil, fmt.Errorf("%w: conversation cycle at %q", ErrConflict, curID)
		}
		seen[curID] = true

		conv, ok, err := r.getConversation(ctx, curID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%w: conversation %q", ErrNotFound, curID)
		}
		entries, err := r.listEntries(ctx, curID, 1, maxSeq)
		if err != nil {
			return nil, err
		}
		chain = append(chain, segment{conv: conv, entries: entries})
		if conv.ParentID == "" {
			break
		}
		maxSeq = conv.ForkEntrySeq
		curID = conv.ParentID
	}

	// Reverse ancestor segments so oldest ancestor entries come first.
	slices.Reverse(chain)
	leaf := chain[len(chain)-1].conv
	headSeq := leaf.HeadSeq

	var combined []Entry
	for _, seg := range chain {
		for _, e := range seg.entries {
			if e.Seq >= headSeq {
				combined = append(combined, e)
			}
		}
	}
	return resolveVisibleEntries(combined), nil
}

// resolveVisibleEntries places the latest active pi.compaction at its cut point so entries
// appended concurrently during background compaction remain in chronological order after the summary.
func resolveVisibleEntries(entries []Entry) []Entry {
	if len(entries) == 0 {
		return nil
	}
	// If any pi.reset somehow fell >= headSeq, slice strictly after the latest reset.
	lastResetIdx := -1
	for i, e := range entries {
		if e.Kind == EntryReset {
			lastResetIdx = i
		}
	}
	if lastResetIdx >= 0 {
		entries = entries[lastResetIdx+1:]
	}

	latestCompIdx := -1
	var latestCutSeq int64
	for i, e := range entries {
		if e.Kind == EntryCompaction {
			latestCompIdx = i
			var p CompactionPayload
			if json.Unmarshal(e.PayloadJSON, &p) == nil {
				latestCutSeq = p.CutSeq
			}
		}
	}
	if latestCompIdx < 0 {
		return entries
	}

	compEntry := entries[latestCompIdx]
	out := make([]Entry, 0, len(entries))
	insertedComp := false
	for i, e := range entries {
		if e.Kind == EntryCompaction {
			if i != latestCompIdx {
				continue
			}
			continue
		}
		if e.Seq <= latestCutSeq {
			continue
		}
		if !insertedComp {
			out = append(out, compEntry)
			insertedComp = true
		}
		out = append(out, e)
	}
	if !insertedComp {
		out = append(out, compEntry)
	}
	return out
}
