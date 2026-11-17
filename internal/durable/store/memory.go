package store

import (
	"context"
	"maps"
	"slices"
	"sync"
)

type entryKey struct {
	conversationID string
	seq            int64
}

type subReqKey struct {
	conversationID string
	requestID      string
}

type taskDedupKey struct {
	ownerTaskID string
	dedupKey    string
}

type sigDedupKey struct {
	taskID     string
	signalName string
	signalKey  string
}

type signalRecord struct {
	signal Signal
	order  uint64
}

type memState struct {
	conversations map[string]Conversation
	entries       map[string][]Entry // keyed by conversationID, sorted by seq ASC
	documents     map[DocKey]Document
	submissions   map[string]Submission
	subByReq      map[subReqKey]string
	tasks         map[string]Task
	taskByDedup   map[taskDedupKey]string
	signals       map[string]signalRecord
	sigByKey      map[sigDedupKey]string
	nextSigOrder  uint64
}

func newMemState() *memState {
	return &memState{
		conversations: make(map[string]Conversation),
		entries:       make(map[string][]Entry),
		documents:     make(map[DocKey]Document),
		submissions:   make(map[string]Submission),
		subByReq:      make(map[subReqKey]string),
		tasks:         make(map[string]Task),
		taskByDedup:   make(map[taskDedupKey]string),
		signals:       make(map[string]signalRecord),
		sigByKey:      make(map[sigDedupKey]string),
	}
}

func (s *memState) clone() *memState {
	cp := &memState{
		conversations: make(map[string]Conversation, len(s.conversations)),
		entries:       make(map[string][]Entry, len(s.entries)),
		documents:     make(map[DocKey]Document, len(s.documents)),
		submissions:   make(map[string]Submission, len(s.submissions)),
		subByReq:      maps.Clone(s.subByReq),
		tasks:         make(map[string]Task, len(s.tasks)),
		taskByDedup:   maps.Clone(s.taskByDedup),
		signals:       make(map[string]signalRecord, len(s.signals)),
		sigByKey:      maps.Clone(s.sigByKey),
		nextSigOrder:  s.nextSigOrder,
	}
	for k, v := range s.conversations {
		cp.conversations[k] = cloneConversation(v)
	}
	for k, list := range s.entries {
		nlist := make([]Entry, len(list))
		for i, e := range list {
			nlist[i] = cloneEntry(e)
		}
		cp.entries[k] = nlist
	}
	for k, v := range s.documents {
		cp.documents[k] = cloneDocument(v)
	}
	for k, v := range s.submissions {
		cp.submissions[k] = cloneSubmission(v)
	}
	for k, v := range s.tasks {
		cp.tasks[k] = cloneTask(v)
	}
	for k, v := range s.signals {
		cp.signals[k] = signalRecord{signal: cloneSignal(v.signal), order: v.order}
	}
	return cp
}

type memoryBackend struct {
	mu        sync.RWMutex
	committed *memState
}

func newMemoryBackend() *memoryBackend {
	return &memoryBackend{committed: newMemState()}
}

func (m *memoryBackend) beginTx(_ context.Context) (backendTx, error) {
	m.mu.RLock()
	working := m.committed.clone()
	m.mu.RUnlock()
	return &memTx{
		backend:    m,
		working:    working,
		savepoints: make(map[string]*memState),
	}, nil
}

func (m *memoryBackend) read(_ context.Context) backendReader {
	return &memReader{backend: m}
}

func (m *memoryBackend) close() error {
	return nil
}

type memReader struct {
	backend *memoryBackend
}

func (r *memReader) getConversation(_ context.Context, id string) (Conversation, bool, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return readConvFromState(r.backend.committed, id)
}

func (r *memReader) listConversationsByOwnerTask(_ context.Context, ownerTaskID string) ([]Conversation, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listConvsByOwnerFromState(r.backend.committed, ownerTaskID)
}

func (r *memReader) listEntries(_ context.Context, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listEntriesFromState(r.backend.committed, conversationID, fromSeq, maxSeq)
}

func (r *memReader) getDocument(_ context.Context, key DocKey) (Document, bool, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return getDocFromState(r.backend.committed, key)
}

func (r *memReader) listDocumentsByScope(_ context.Context, scopeKind, scopeID string) ([]Document, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listDocsByScopeFromState(r.backend.committed, scopeKind, scopeID)
}

func (r *memReader) getSubmission(_ context.Context, id string) (Submission, bool, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return getSubFromState(r.backend.committed, id)
}

func (r *memReader) getSubmissionByRequestID(_ context.Context, conversationID, requestID string) (Submission, bool, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return getSubByReqFromState(r.backend.committed, conversationID, requestID)
}

func (r *memReader) getTask(_ context.Context, id string) (Task, bool, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return getTaskFromState(r.backend.committed, id)
}

func (r *memReader) getTaskByDedupKey(_ context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return getTaskByDedupFromState(r.backend.committed, ownerTaskID, dedupKey)
}

func (r *memReader) listTasksByOwner(_ context.Context, ownerTaskID string) ([]Task, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listTasksByOwnerFromState(r.backend.committed, ownerTaskID)
}

func (r *memReader) listTasksByStatus(_ context.Context, statuses []TaskStatus) ([]Task, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listTasksByStatusFromState(r.backend.committed, statuses)
}

func (r *memReader) listTasksByConversation(_ context.Context, conversationID string) ([]Task, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listTasksByConvFromState(r.backend.committed, conversationID)
}

func (r *memReader) listSignals(_ context.Context, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	r.backend.mu.RLock()
	defer r.backend.mu.RUnlock()
	return listSignalsFromState(r.backend.committed, taskID, signalName, onlyUnconsumed)
}

type memTx struct {
	backend    *memoryBackend
	working    *memState
	savepoints map[string]*memState
	closed     bool
}

func (t *memTx) savepoint(_ context.Context, name string) error {
	t.savepoints[name] = t.working.clone()
	return nil
}

func (t *memTx) rollbackToSavepoint(_ context.Context, name string) error {
	snap, ok := t.savepoints[name]
	if !ok {
		return ErrNotFound
	}
	t.working = snap.clone()
	return nil
}

func (t *memTx) releaseSavepoint(_ context.Context, name string) error {
	delete(t.savepoints, name)
	return nil
}

func (t *memTx) commit(_ context.Context) error {
	if t.closed {
		return ErrStoreClosed
	}
	t.backend.mu.Lock()
	t.backend.committed = t.working
	t.backend.mu.Unlock()
	t.closed = true
	return nil
}

func (t *memTx) rollback() error {
	t.closed = true
	t.savepoints = nil
	return nil
}

func (t *memTx) getConversation(_ context.Context, id string) (Conversation, bool, error) {
	return readConvFromState(t.working, id)
}

func (t *memTx) listConversationsByOwnerTask(_ context.Context, ownerTaskID string) ([]Conversation, error) {
	return listConvsByOwnerFromState(t.working, ownerTaskID)
}

func (t *memTx) listEntries(_ context.Context, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	return listEntriesFromState(t.working, conversationID, fromSeq, maxSeq)
}

func (t *memTx) getDocument(_ context.Context, key DocKey) (Document, bool, error) {
	return getDocFromState(t.working, key)
}

func (t *memTx) listDocumentsByScope(_ context.Context, scopeKind, scopeID string) ([]Document, error) {
	return listDocsByScopeFromState(t.working, scopeKind, scopeID)
}

func (t *memTx) getSubmission(_ context.Context, id string) (Submission, bool, error) {
	return getSubFromState(t.working, id)
}

func (t *memTx) getSubmissionByRequestID(_ context.Context, conversationID, requestID string) (Submission, bool, error) {
	return getSubByReqFromState(t.working, conversationID, requestID)
}

func (t *memTx) getTask(_ context.Context, id string) (Task, bool, error) {
	return getTaskFromState(t.working, id)
}

func (t *memTx) getTaskByDedupKey(_ context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	return getTaskByDedupFromState(t.working, ownerTaskID, dedupKey)
}

func (t *memTx) listTasksByOwner(_ context.Context, ownerTaskID string) ([]Task, error) {
	return listTasksByOwnerFromState(t.working, ownerTaskID)
}

func (t *memTx) listTasksByStatus(_ context.Context, statuses []TaskStatus) ([]Task, error) {
	return listTasksByStatusFromState(t.working, statuses)
}

func (t *memTx) listTasksByConversation(_ context.Context, conversationID string) ([]Task, error) {
	return listTasksByConvFromState(t.working, conversationID)
}

func (t *memTx) listSignals(_ context.Context, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	return listSignalsFromState(t.working, taskID, signalName, onlyUnconsumed)
}

func (t *memTx) insertConversation(_ context.Context, conv Conversation) error {
	if _, exists := t.working.conversations[conv.ID]; exists {
		return ErrDuplicate
	}
	t.working.conversations[conv.ID] = cloneConversation(conv)
	return nil
}

func (t *memTx) updateConversation(_ context.Context, conv Conversation) error {
	if _, exists := t.working.conversations[conv.ID]; !exists {
		return ErrNotFound
	}
	t.working.conversations[conv.ID] = cloneConversation(conv)
	return nil
}

func (t *memTx) insertEntry(_ context.Context, entry Entry) error {
	list := t.working.entries[entry.ConversationID]
	for _, existing := range list {
		if existing.Seq == entry.Seq {
			return ErrDuplicate
		}
	}
	list = append(list, cloneEntry(entry))
	slices.SortFunc(list, func(a, b Entry) int {
		if a.Seq < b.Seq {
			return -1
		}
		if a.Seq > b.Seq {
			return 1
		}
		return 0
	})
	t.working.entries[entry.ConversationID] = list
	return nil
}

func (t *memTx) upsertDocument(_ context.Context, doc Document) (Document, error) {
	key := DocKey{ScopeKind: doc.ScopeKind, ScopeID: doc.ScopeID, DocKind: doc.DocKind}
	if prev, ok := t.working.documents[key]; ok {
		doc.Rev = prev.Rev + 1
	} else {
		doc.Rev = 1
	}
	cp := cloneDocument(doc)
	t.working.documents[key] = cp
	return cloneDocument(cp), nil
}

func (t *memTx) deleteDocument(_ context.Context, key DocKey) (bool, error) {
	if _, ok := t.working.documents[key]; !ok {
		return false, nil
	}
	delete(t.working.documents, key)
	return true, nil
}

func (t *memTx) insertSubmission(_ context.Context, sub Submission) error {
	if _, exists := t.working.submissions[sub.ID]; exists {
		return ErrDuplicate
	}
	rk := subReqKey{conversationID: sub.ConversationID, requestID: sub.RequestID}
	if _, exists := t.working.subByReq[rk]; exists {
		return ErrDuplicate
	}
	t.working.submissions[sub.ID] = cloneSubmission(sub)
	t.working.subByReq[rk] = sub.ID
	return nil
}

func (t *memTx) updateSubmission(_ context.Context, sub Submission) error {
	if _, exists := t.working.submissions[sub.ID]; !exists {
		return ErrNotFound
	}
	t.working.submissions[sub.ID] = cloneSubmission(sub)
	return nil
}

func (t *memTx) insertTask(_ context.Context, task Task) error {
	if _, exists := t.working.tasks[task.ID]; exists {
		return ErrDuplicate
	}
	if task.DedupKey != "" {
		dk := taskDedupKey{ownerTaskID: task.OwnerTaskID, dedupKey: task.DedupKey}
		if _, exists := t.working.taskByDedup[dk]; exists {
			return ErrDuplicate
		}
		t.working.taskByDedup[dk] = task.ID
	}
	t.working.tasks[task.ID] = cloneTask(task)
	return nil
}

func (t *memTx) updateTask(_ context.Context, task Task) error {
	if _, exists := t.working.tasks[task.ID]; !exists {
		return ErrNotFound
	}
	t.working.tasks[task.ID] = cloneTask(task)
	return nil
}

func (t *memTx) insertSignal(_ context.Context, sig Signal) error {
	if _, exists := t.working.signals[sig.ID]; exists {
		return ErrDuplicate
	}
	if sig.SignalKey != "" {
		sk := sigDedupKey{taskID: sig.TaskID, signalName: sig.SignalName, signalKey: sig.SignalKey}
		if _, exists := t.working.sigByKey[sk]; exists {
			return ErrDuplicate
		}
		t.working.sigByKey[sk] = sig.ID
	}
	t.working.nextSigOrder++
	t.working.signals[sig.ID] = signalRecord{signal: cloneSignal(sig), order: t.working.nextSigOrder}
	return nil
}

func (t *memTx) getSignalByKey(_ context.Context, taskID, signalName, signalKey string) (Signal, bool, error) {
	if signalKey == "" {
		return Signal{}, false, nil
	}
	id, ok := t.working.sigByKey[sigDedupKey{taskID: taskID, signalName: signalName, signalKey: signalKey}]
	if !ok {
		return Signal{}, false, nil
	}
	rec, ok := t.working.signals[id]
	if !ok {
		return Signal{}, false, nil
	}
	return cloneSignal(rec.signal), true, nil
}

func (t *memTx) markSignalConsumed(_ context.Context, signalID string, consumedAtMs int64) error {
	rec, ok := t.working.signals[signalID]
	if !ok {
		return ErrNotFound
	}
	if rec.signal.Consumed {
		return ErrConflict
	}
	rec.signal.Consumed = true
	rec.signal.ConsumedAtMs = consumedAtMs
	t.working.signals[signalID] = rec
	return nil
}

func readConvFromState(s *memState, id string) (Conversation, bool, error) {
	c, ok := s.conversations[id]
	if !ok {
		return Conversation{}, false, nil
	}
	return cloneConversation(c), true, nil
}

func listConvsByOwnerFromState(s *memState, ownerTaskID string) ([]Conversation, error) {
	var out []Conversation
	for _, c := range s.conversations {
		if c.OwnerTaskID == ownerTaskID {
			out = append(out, cloneConversation(c))
		}
	}
	slices.SortFunc(out, func(a, b Conversation) int {
		if a.CreatedAtMs != b.CreatedAtMs {
			if a.CreatedAtMs < b.CreatedAtMs {
				return -1
			}
			return 1
		}
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
	return out, nil
}

func listEntriesFromState(s *memState, conversationID string, fromSeq, maxSeq int64) ([]Entry, error) {
	list := s.entries[conversationID]
	var out []Entry
	for _, e := range list {
		if e.Seq < fromSeq {
			continue
		}
		if maxSeq > 0 && e.Seq > maxSeq {
			continue
		}
		out = append(out, cloneEntry(e))
	}
	return out, nil
}

func getDocFromState(s *memState, key DocKey) (Document, bool, error) {
	d, ok := s.documents[key]
	if !ok {
		return Document{}, false, nil
	}
	return cloneDocument(d), true, nil
}

func listDocsByScopeFromState(s *memState, scopeKind, scopeID string) ([]Document, error) {
	var out []Document
	for k, d := range s.documents {
		if k.ScopeKind == scopeKind && k.ScopeID == scopeID {
			out = append(out, cloneDocument(d))
		}
	}
	slices.SortFunc(out, func(a, b Document) int {
		if a.DocKind < b.DocKind {
			return -1
		}
		if a.DocKind > b.DocKind {
			return 1
		}
		return 0
	})
	return out, nil
}

func getSubFromState(s *memState, id string) (Submission, bool, error) {
	sub, ok := s.submissions[id]
	if !ok {
		return Submission{}, false, nil
	}
	return cloneSubmission(sub), true, nil
}

func getSubByReqFromState(s *memState, conversationID, requestID string) (Submission, bool, error) {
	id, ok := s.subByReq[subReqKey{conversationID: conversationID, requestID: requestID}]
	if !ok {
		return Submission{}, false, nil
	}
	return getSubFromState(s, id)
}

func getTaskFromState(s *memState, id string) (Task, bool, error) {
	task, ok := s.tasks[id]
	if !ok {
		return Task{}, false, nil
	}
	return cloneTask(task), true, nil
}

func getTaskByDedupFromState(s *memState, ownerTaskID, dedupKey string) (Task, bool, error) {
	if dedupKey == "" {
		return Task{}, false, nil
	}
	id, ok := s.taskByDedup[taskDedupKey{ownerTaskID: ownerTaskID, dedupKey: dedupKey}]
	if !ok {
		return Task{}, false, nil
	}
	return getTaskFromState(s, id)
}

func listTasksByOwnerFromState(s *memState, ownerTaskID string) ([]Task, error) {
	var out []Task
	for _, t := range s.tasks {
		if t.OwnerTaskID == ownerTaskID {
			out = append(out, cloneTask(t))
		}
	}
	sortTasks(out)
	return out, nil
}

func listTasksByStatusFromState(s *memState, statuses []TaskStatus) ([]Task, error) {
	want := make(map[TaskStatus]bool, len(statuses))
	for _, st := range statuses {
		want[st] = true
	}
	var out []Task
	for _, t := range s.tasks {
		if len(want) == 0 || want[t.Status] {
			out = append(out, cloneTask(t))
		}
	}
	sortTasks(out)
	return out, nil
}

func listTasksByConvFromState(s *memState, conversationID string) ([]Task, error) {
	var out []Task
	for _, t := range s.tasks {
		if t.ConversationID == conversationID {
			out = append(out, cloneTask(t))
		}
	}
	sortTasks(out)
	return out, nil
}

func sortTasks(tasks []Task) {
	slices.SortFunc(tasks, func(a, b Task) int {
		if a.CreatedAtMs != b.CreatedAtMs {
			if a.CreatedAtMs < b.CreatedAtMs {
				return -1
			}
			return 1
		}
		if a.ID < b.ID {
			return -1
		}
		if a.ID > b.ID {
			return 1
		}
		return 0
	})
}

func listSignalsFromState(s *memState, taskID, signalName string, onlyUnconsumed bool) ([]Signal, error) {
	var recs []signalRecord
	for _, rec := range s.signals {
		if rec.signal.TaskID != taskID {
			continue
		}
		if signalName != "" && rec.signal.SignalName != signalName {
			continue
		}
		if onlyUnconsumed && rec.signal.Consumed {
			continue
		}
		recs = append(recs, signalRecord{signal: cloneSignal(rec.signal), order: rec.order})
	}
	slices.SortFunc(recs, func(a, b signalRecord) int {
		if a.signal.CreatedAtMs != b.signal.CreatedAtMs {
			if a.signal.CreatedAtMs < b.signal.CreatedAtMs {
				return -1
			}
			return 1
		}
		if a.order < b.order {
			return -1
		}
		if a.order > b.order {
			return 1
		}
		return 0
	})
	out := make([]Signal, len(recs))
	for i, r := range recs {
		out[i] = r.signal
	}
	return out, nil
}
