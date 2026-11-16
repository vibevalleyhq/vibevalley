package store

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// LiveMemoryFlushInterval is the coalesced memory-view push cadence for deferred pi.live writes.
	LiveMemoryFlushInterval = 100 * time.Millisecond
	// LiveDiskFlushInterval is the coalesced disk Group Commit cadence for deferred pi.live writes.
	LiveDiskFlushInterval = 1000 * time.Millisecond

	maxGroupCommitBatch = 64
)

// Option configures a Store instance.
type Option func(*storeConfig)

type storeConfig struct {
	clock        Clock
	beforeCommit func() error
}

// WithClock overrides the clock used by Group Commit timestamps and deferred pi.live timers.
func WithClock(clock Clock) Option {
	return func(c *storeConfig) {
		if clock != nil {
			c.clock = clock
		}
	}
}

// WithBeforeCommitHook installs a hook invoked immediately before each backend Commit.
// Returning an error aborts the commit so tests can verify disk-before-memory atomicity.
func WithBeforeCommitHook(fn func() error) Option {
	return func(c *storeConfig) {
		c.beforeCommit = fn
	}
}

type commitRequest struct {
	ctx  context.Context
	fn   func(tx *Tx) error
	done chan error
}

type pendingLiveDoc struct {
	stateJSON   []byte
	updatedAtMs int64
	gen         uint64
	memDirty    bool
	diskDirty   bool
}

// Store provides single-writer atomic Group Commit, deferred pi.live coalesced flushing,
// and portable persistence across in-memory and SQLite WAL backends.
type Store struct {
	backend      backend
	clock        Clock
	beforeCommit func() error

	writeCh   chan *commitRequest
	stopCh    chan struct{}
	crashCh   chan struct{}
	wg        sync.WaitGroup
	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error

	observersMu sync.RWMutex
	observers   map[uint64]DocumentObserver
	nextObsID   atomic.Uint64

	liveMu        sync.Mutex
	dirtyLive     map[DocKey]*pendingLiveDoc
	publishedLive map[DocKey]Document
	committedGen  map[DocKey]uint64
	memTimer      Timer
	diskTimer     Timer
	liveGen       uint64

	statRequests            atomic.Int64
	statBatches             atomic.Int64
	statCommittedOps        atomic.Int64
	statFailedOps           atomic.Int64
	statCoalescedLiveMemory atomic.Int64
	statCoalescedLiveDisk   atomic.Int64
}

// NewMemory creates an in-memory Store with full Group Commit and deferred pi.live semantics.
func NewMemory(opts ...Option) *Store {
	return newStore(newMemoryBackend(), opts...)
}

// OpenSQLite opens (or creates) a SQLite WAL Store with synchronous=NORMAL.
func OpenSQLite(ctx context.Context, path string, opts ...Option) (*Store, error) {
	b, err := openSQLiteBackend(ctx, path)
	if err != nil {
		return nil, err
	}
	return newStore(b, opts...), nil
}

func newStore(b backend, opts ...Option) *Store {
	cfg := storeConfig{
		clock: RealClock{},
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	s := &Store{
		backend:       b,
		clock:         cfg.clock,
		beforeCommit:  cfg.beforeCommit,
		writeCh:       make(chan *commitRequest, 256),
		stopCh:        make(chan struct{}),
		crashCh:       make(chan struct{}),
		observers:     make(map[uint64]DocumentObserver),
		dirtyLive:     make(map[DocKey]*pendingLiveDoc),
		publishedLive: make(map[DocKey]Document),
		committedGen:  make(map[DocKey]uint64),
	}
	s.wg.Add(1)
	go s.writeLoop()
	return s
}

// Clock returns the Store's configured Clock.
func (s *Store) Clock() Clock { return s.clock }

// SQLitePragmas returns the active journal_mode and synchronous settings when backed by SQLite.
func (s *Store) SQLitePragmas(ctx context.Context) (journalMode string, synchronous int, ok bool, err error) {
	sb, isSQLite := s.backend.(*sqliteBackend)
	if !isSQLite {
		return "", 0, false, nil
	}
	jm, syncMode, err := sb.pragmas(ctx)
	return jm, syncMode, true, err
}

// Stats returns a snapshot of Group Commit and deferred pi.live metrics.
func (s *Store) Stats() GroupCommitStats {
	return GroupCommitStats{
		Requests:            s.statRequests.Load(),
		Batches:             s.statBatches.Load(),
		CommittedOps:        s.statCommittedOps.Load(),
		FailedOps:           s.statFailedOps.Load(),
		CoalescedLiveMemory: s.statCoalescedLiveMemory.Load(),
		CoalescedLiveDisk:   s.statCoalescedLiveDisk.Load(),
	}
}

// SubscribeDocuments registers an observer notified strictly AFTER disk commit
// (or on 100ms deferred pi.live memory push). Returns an unsubscribe function.
func (s *Store) SubscribeDocuments(obs DocumentObserver) func() {
	if obs == nil {
		return func() {}
	}
	id := s.nextObsID.Add(1)
	s.observersMu.Lock()
	s.observers[id] = obs
	s.observersMu.Unlock()
	return func() {
		s.observersMu.Lock()
		delete(s.observers, id)
		s.observersMu.Unlock()
	}
}

func (s *Store) notifyObservers(events []DocumentEvent) {
	if len(events) == 0 {
		return
	}
	s.observersMu.RLock()
	if len(s.observers) == 0 {
		s.observersMu.RUnlock()
		return
	}
	list := make([]DocumentObserver, 0, len(s.observers))
	for _, obs := range s.observers {
		list = append(list, obs)
	}
	s.observersMu.RUnlock()

	for _, ev := range events {
		for _, obs := range list {
			obs.OnDocumentChange(DocumentEvent{
				ScopeKind:   ev.ScopeKind,
				ScopeID:     ev.ScopeID,
				DocKind:     ev.DocKind,
				Rev:         ev.Rev,
				StateJSON:   cloneBytes(ev.StateJSON),
				Retired:     ev.Retired,
				Durable:     ev.Durable,
				UpdatedAtMs: ev.UpdatedAtMs,
			})
		}
	}
}

// Mutate runs fn inside the single-writer atomic Group Commit batch loop.
func (s *Store) Mutate(ctx context.Context, fn func(tx *Tx) error) error {
	if s.closed.Load() {
		return ErrStoreClosed
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	req := &commitRequest{
		ctx:  ctx,
		fn:   fn,
		done: make(chan error, 1),
	}
	s.statRequests.Add(1)
	select {
	case s.writeCh <- req:
	case <-s.stopCh:
		return ErrStoreClosed
	case <-s.crashCh:
		return ErrStoreClosed
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-req.done:
		return err
	case <-s.crashCh:
		return ErrStoreClosed
	}
}

func (s *Store) writeLoop() {
	defer s.wg.Done()
	for {
		var first *commitRequest
		select {
		case first = <-s.writeCh:
		case <-s.crashCh:
			return
		case <-s.stopCh:
			s.drainRemainingOnStop()
			return
		}

		batch := make([]*commitRequest, 0, maxGroupCommitBatch)
		batch = append(batch, first)
		for len(batch) < maxGroupCommitBatch {
			select {
			case next := <-s.writeCh:
				batch = append(batch, next)
			default:
				goto flushBatch
			}
		}
	flushBatch:
		s.commitBatch(batch)
	}
}

func (s *Store) drainRemainingOnStop() {
	for {
		var batch []*commitRequest
		for len(batch) < maxGroupCommitBatch {
			select {
			case req := <-s.writeCh:
				batch = append(batch, req)
			default:
				goto doneDrain
			}
		}
	doneDrain:
		if len(batch) == 0 {
			return
		}
		s.commitBatch(batch)
	}
}

func (s *Store) commitBatch(batch []*commitRequest) {
	// Cancel requests already cancelled before entering DB tx.
	active := make([]*commitRequest, 0, len(batch))
	for _, req := range batch {
		if err := req.ctx.Err(); err != nil {
			s.statFailedOps.Add(1)
			req.done <- err
			continue
		}
		active = append(active, req)
	}
	if len(active) == 0 {
		return
	}

	s.statBatches.Add(1)
	btx, err := s.backend.beginTx(context.Background())
	if err != nil {
		s.statFailedOps.Add(int64(len(active)))
		for _, req := range active {
			req.done <- err
		}
		return
	}

	nowMs := s.clock.NowMs()
	results := make([]error, len(active))
	var committedEvents []DocumentEvent
	succeeded := 0

	for i, req := range active {
		spName := formatSavepointName(i)
		if err := btx.savepoint(context.Background(), spName); err != nil {
			_ = btx.rollback()
			s.statFailedOps.Add(int64(len(active)))
			for _, r := range active {
				r.done <- err
			}
			return
		}
		tx := &Tx{btx: btx, nowMs: nowMs}
		opErr := req.fn(tx)
		if opErr != nil {
			_ = btx.rollbackToSavepoint(context.Background(), spName)
			results[i] = opErr
			continue
		}
		if err := btx.releaseSavepoint(context.Background(), spName); err != nil {
			_ = btx.rollback()
			s.statFailedOps.Add(int64(len(active)))
			for _, r := range active {
				r.done <- err
			}
			return
		}
		succeeded++
		committedEvents = append(committedEvents, tx.docEvents...)
	}

	if succeeded == 0 {
		_ = btx.rollback()
		s.statFailedOps.Add(int64(len(active)))
		for i, req := range active {
			req.done <- results[i]
		}
		return
	}

	if s.beforeCommit != nil {
		if hookErr := s.beforeCommit(); hookErr != nil {
			_ = btx.rollback()
			s.statFailedOps.Add(int64(len(active)))
			for _, req := range active {
				req.done <- hookErr
			}
			return
		}
	}

	if commitErr := btx.commit(context.Background()); commitErr != nil {
		_ = btx.rollback()
		s.statFailedOps.Add(int64(len(active)))
		for _, req := range active {
			req.done <- commitErr
		}
		return
	}

	// Disk commit succeeded: now update published memory cache and notify observers ("commit disk before memory/notifications").
	s.statCommittedOps.Add(int64(succeeded))
	s.statFailedOps.Add(int64(len(active) - succeeded))
	s.reconcilePublishedLive(committedEvents)
	s.notifyObservers(committedEvents)

	for i, req := range active {
		req.done <- results[i]
	}
}

func (s *Store) reconcilePublishedLive(events []DocumentEvent) {
	if len(events) == 0 {
		return
	}
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	for _, ev := range events {
		if ev.DocKind != DocLive {
			continue
		}
		key := DocKey{ScopeKind: ev.ScopeKind, ScopeID: ev.ScopeID, DocKind: ev.DocKind}
		if ev.Retired {
			delete(s.publishedLive, key)
			continue
		}
		s.publishedLive[key] = Document{
			ScopeKind:   ev.ScopeKind,
			ScopeID:     ev.ScopeID,
			DocKind:     ev.DocKind,
			Rev:         ev.Rev,
			StateJSON:   cloneBytes(ev.StateJSON),
			UpdatedAtMs: ev.UpdatedAtMs,
		}
	}
}

// PutDocumentDeferred stages a pi.live streaming update in memory for 100ms coalesced
// memory-view delivery and 1000ms coalesced disk Group Commit.
// Only docKind == DocLive ("pi.live") is permitted.
func (s *Store) PutDocumentDeferred(ctx context.Context, scopeKind, scopeID, docKind string, stateJSON []byte) error {
	if docKind != DocLive {
		return ErrDeferredOnlyForLive
	}
	if scopeKind == "" || scopeID == "" {
		return fmt.Errorf("%w: scopeKind and scopeId required", ErrInvalidArgument)
	}
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	validJSON, err := requireJSON(stateJSON, "{}")
	if err != nil {
		return fmt.Errorf("%w: stateJson: %v", ErrInvalidArgument, err)
	}

	key := DocKey{ScopeKind: scopeKind, ScopeID: scopeID, DocKind: DocLive}
	nowMs := s.clock.NowMs()

	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	if s.closed.Load() {
		return ErrStoreClosed
	}
	s.liveGen++
	s.dirtyLive[key] = &pendingLiveDoc{
		stateJSON:   validJSON,
		updatedAtMs: nowMs,
		gen:         s.liveGen,
		memDirty:    true,
		diskDirty:   true,
	}
	if s.memTimer == nil {
		s.memTimer = s.clock.AfterFunc(LiveMemoryFlushInterval, s.onLiveMemoryTick)
	}
	if s.diskTimer == nil {
		s.diskTimer = s.clock.AfterFunc(LiveDiskFlushInterval, s.onLiveDiskTick)
	}
	return nil
}

func (s *Store) onLiveMemoryTick() {
	s.pushDeferredMemoryView()
}

func (s *Store) pushDeferredMemoryView() {
	s.liveMu.Lock()
	s.memTimer = nil
	if s.closed.Load() {
		s.liveMu.Unlock()
		return
	}
	var events []DocumentEvent
	for key, entry := range s.dirtyLive {
		if !entry.memDirty {
			continue
		}
		entry.memDirty = false
		rev := int64(1)
		if prev, ok := s.publishedLive[key]; ok {
			rev = prev.Rev + 1
		}
		doc := Document{
			ScopeKind:   key.ScopeKind,
			ScopeID:     key.ScopeID,
			DocKind:     key.DocKind,
			Rev:         rev,
			StateJSON:   cloneBytes(entry.stateJSON),
			UpdatedAtMs: entry.updatedAtMs,
		}
		s.publishedLive[key] = doc
		events = append(events, DocumentEvent{
			ScopeKind:   doc.ScopeKind,
			ScopeID:     doc.ScopeID,
			DocKind:     doc.DocKind,
			Rev:         doc.Rev,
			StateJSON:   cloneBytes(doc.StateJSON),
			Durable:     false,
			UpdatedAtMs: doc.UpdatedAtMs,
		})
	}
	s.liveMu.Unlock()

	if len(events) > 0 {
		s.statCoalescedLiveMemory.Add(int64(len(events)))
		s.notifyObservers(events)
	}
}

func (s *Store) onLiveDiskTick() {
	_ = s.flushDeferredDisk(context.Background())
}

// FlushDeferred pushes any dirty pi.live state to the memory view and flushes all
// dirty pi.live updates through the Group Commit writer to disk.
func (s *Store) FlushDeferred(ctx context.Context) error {
	s.pushDeferredMemoryView()
	return s.flushDeferredDisk(ctx)
}

func (s *Store) flushDeferredDisk(ctx context.Context) error {
	type liveSnap struct {
		key         DocKey
		stateJSON   []byte
		updatedAtMs int64
		gen         uint64
	}

	s.liveMu.Lock()
	if s.diskTimer != nil {
		s.diskTimer.Stop()
		s.diskTimer = nil
	}
	if s.closed.Load() {
		s.liveMu.Unlock()
		return nil
	}
	var batch []liveSnap
	for key, entry := range s.dirtyLive {
		if !entry.diskDirty {
			continue
		}
		batch = append(batch, liveSnap{
			key:         key,
			stateJSON:   cloneBytes(entry.stateJSON),
			updatedAtMs: entry.updatedAtMs,
			gen:         entry.gen,
		})
		entry.diskDirty = false
	}
	s.liveMu.Unlock()

	if len(batch) == 0 {
		return nil
	}

	err := s.Mutate(ctx, func(tx *Tx) error {
		for _, item := range batch {
			s.liveMu.Lock()
			immGen := s.committedGen[item.key]
			s.liveMu.Unlock()
			if immGen > item.gen {
				// An immediate pi.live commit already superseded this older deferred write.
				continue
			}
			if _, err := tx.PutDocument(ctx, item.key.ScopeKind, item.key.ScopeID, item.key.DocKind, item.stateJSON); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		// Restore dirty bits if disk flush failed so next tick retries.
		s.liveMu.Lock()
		for _, item := range batch {
			if cur, ok := s.dirtyLive[item.key]; ok && cur.gen == item.gen {
				cur.diskDirty = true
			}
		}
		s.liveMu.Unlock()
		return err
	}

	s.statCoalescedLiveDisk.Add(int64(len(batch)))

	s.liveMu.Lock()
	needRearm := false
	for _, item := range batch {
		cur, ok := s.dirtyLive[item.key]
		if !ok {
			continue
		}
		if cur.gen == item.gen && !cur.memDirty && !cur.diskDirty {
			delete(s.dirtyLive, item.key)
		} else if cur.diskDirty {
			needRearm = true
		}
	}
	if needRearm && s.diskTimer == nil && !s.closed.Load() {
		s.diskTimer = s.clock.AfterFunc(LiveDiskFlushInterval, s.onLiveDiskTick)
	}
	s.liveMu.Unlock()
	return nil
}

// PutDocument immediately commits a durable_document row via Group Commit.
// For pi.live, this also supersedes older deferred writes for the same key.
func (s *Store) PutDocument(ctx context.Context, scopeKind, scopeID, docKind string, stateJSON []byte) (Document, error) {
	var out Document
	var markerGen uint64
	if docKind == DocLive {
		s.liveMu.Lock()
		s.liveGen++
		markerGen = s.liveGen
		key := DocKey{ScopeKind: scopeKind, ScopeID: scopeID, DocKind: DocLive}
		s.committedGen[key] = markerGen
		delete(s.dirtyLive, key)
		s.liveMu.Unlock()
	}
	err := s.Mutate(ctx, func(tx *Tx) error {
		doc, err := tx.PutDocument(ctx, scopeKind, scopeID, docKind, stateJSON)
		if err != nil {
			return err
		}
		out = doc
		return nil
	})
	return out, err
}

// GetLiveDocument returns the latest 100ms-pushed memory view for pi.live if newer
// than disk, or falls back to the committed durable_document on disk.
func (s *Store) GetLiveDocument(ctx context.Context, scopeKind, scopeID string) (Document, error) {
	key := DocKey{ScopeKind: scopeKind, ScopeID: scopeID, DocKind: DocLive}
	s.liveMu.Lock()
	if doc, ok := s.publishedLive[key]; ok {
		cp := cloneDocument(doc)
		s.liveMu.Unlock()
		return cp, nil
	}
	s.liveMu.Unlock()
	return s.GetDocument(ctx, scopeKind, scopeID, DocLive)
}

// Close gracefully flushes deferred pi.live updates, drains queued Group Commit
// requests, waits for all background goroutines to exit, and closes the backend.
func (s *Store) Close() error {
	s.closeOnce.Do(func() {
		s.liveMu.Lock()
		if s.memTimer != nil {
			s.memTimer.Stop()
			s.memTimer = nil
		}
		if s.diskTimer != nil {
			s.diskTimer.Stop()
			s.diskTimer = nil
		}
		s.liveMu.Unlock()

		if !s.closed.Load() {
			_ = s.FlushDeferred(context.Background())
		}

		s.liveMu.Lock()
		if s.memTimer != nil {
			s.memTimer.Stop()
			s.memTimer = nil
		}
		if s.diskTimer != nil {
			s.diskTimer.Stop()
			s.diskTimer = nil
		}
		s.liveMu.Unlock()

		if !s.closed.Swap(true) {
			close(s.stopCh)
		}
		s.wg.Wait()
		s.closeErr = s.backend.close()
	})
	return s.closeErr
}

// SimulateCrash immediately stops timers and the writer loop WITHOUT flushing dirty
// deferred pi.live buffers, allowing crash-recovery tests to verify what reached disk.
func (s *Store) SimulateCrash() error {
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		s.liveMu.Lock()
		if s.memTimer != nil {
			s.memTimer.Stop()
			s.memTimer = nil
		}
		if s.diskTimer != nil {
			s.diskTimer.Stop()
			s.diskTimer = nil
		}
		s.dirtyLive = make(map[DocKey]*pendingLiveDoc)
		s.publishedLive = make(map[DocKey]Document)
		s.liveMu.Unlock()

		close(s.crashCh)
		s.wg.Wait()
		s.closeErr = s.backend.close()
	})
	return s.closeErr
}

// Convenience single-op and read helpers delegating to Mutate / backendReader.

func (s *Store) CreateConversation(ctx context.Context, conv Conversation) (Conversation, error) {
	var out Conversation
	err := s.Mutate(ctx, func(tx *Tx) error {
		c, err := tx.CreateConversation(ctx, conv)
		if err != nil {
			return err
		}
		out = c
		return nil
	})
	return out, err
}

func (s *Store) ForkConversation(ctx context.Context, parentID, childID, ownerTaskID, providerAffinity string, forkEntrySeq int64) (Conversation, error) {
	var out Conversation
	err := s.Mutate(ctx, func(tx *Tx) error {
		c, err := tx.ForkConversation(ctx, parentID, childID, ownerTaskID, providerAffinity, forkEntrySeq)
		if err != nil {
			return err
		}
		out = c
		return nil
	})
	return out, err
}

func (s *Store) GetConversation(ctx context.Context, id string) (Conversation, error) {
	c, ok, err := s.backend.read(ctx).getConversation(ctx, id)
	if err != nil {
		return Conversation{}, err
	}
	if !ok {
		return Conversation{}, fmt.Errorf("%w: conversation %q", ErrNotFound, id)
	}
	return c, nil
}

func (s *Store) ListConversationsByOwnerTask(ctx context.Context, ownerTaskID string) ([]Conversation, error) {
	return s.backend.read(ctx).listConversationsByOwnerTask(ctx, ownerTaskID)
}

func (s *Store) AppendEntry(ctx context.Context, conversationID, kind string, payloadJSON []byte) (Entry, error) {
	var out Entry
	err := s.Mutate(ctx, func(tx *Tx) error {
		e, err := tx.AppendEntry(ctx, conversationID, kind, payloadJSON)
		if err != nil {
			return err
		}
		out = e
		return nil
	})
	return out, err
}

func (s *Store) GetEntries(ctx context.Context, conversationID string, fromSeq int64) ([]Entry, error) {
	if fromSeq < 1 {
		fromSeq = 1
	}
	return s.backend.read(ctx).listEntries(ctx, conversationID, fromSeq, 0)
}

func (s *Store) GetVisibleEntries(ctx context.Context, conversationID string) ([]Entry, error) {
	return loadVisibleEntries(ctx, s.backend.read(ctx), conversationID)
}

func (s *Store) CommitCompaction(ctx context.Context, req CompactionCommit) (CompactionOutcome, error) {
	var out CompactionOutcome
	err := s.Mutate(ctx, func(tx *Tx) error {
		o, err := tx.CommitCompaction(ctx, req)
		if err != nil {
			return err
		}
		out = o
		return nil
	})
	return out, err
}

func (s *Store) AppendReset(ctx context.Context, conversationID string, payloadJSON []byte) (Entry, error) {
	var out Entry
	err := s.Mutate(ctx, func(tx *Tx) error {
		e, err := tx.AppendReset(ctx, conversationID, payloadJSON)
		if err != nil {
			return err
		}
		out = e
		return nil
	})
	return out, err
}

func (s *Store) GetDocument(ctx context.Context, scopeKind, scopeID, docKind string) (Document, error) {
	doc, ok, err := s.backend.read(ctx).getDocument(ctx, DocKey{ScopeKind: scopeKind, ScopeID: scopeID, DocKind: docKind})
	if err != nil {
		return Document{}, err
	}
	if !ok {
		return Document{}, fmt.Errorf("%w: document (%s,%s,%s)", ErrNotFound, scopeKind, scopeID, docKind)
	}
	return doc, nil
}

func (s *Store) ListDocumentsByScope(ctx context.Context, scopeKind, scopeID string) ([]Document, error) {
	return s.backend.read(ctx).listDocumentsByScope(ctx, scopeKind, scopeID)
}

func (s *Store) Submit(ctx context.Context, sub Submission) (SubmitResult, error) {
	var out SubmitResult
	err := s.Mutate(ctx, func(tx *Tx) error {
		r, err := tx.Submit(ctx, sub)
		if err != nil {
			return err
		}
		out = r
		return nil
	})
	return out, err
}

func (s *Store) UpdateSubmissionStatus(ctx context.Context, id, status string) (Submission, error) {
	var out Submission
	err := s.Mutate(ctx, func(tx *Tx) error {
		sub, err := tx.UpdateSubmissionStatus(ctx, id, status)
		if err != nil {
			return err
		}
		out = sub
		return nil
	})
	return out, err
}

func (s *Store) SettleSubmission(ctx context.Context, id, status string, resultJSON []byte) (Submission, error) {
	var out Submission
	err := s.Mutate(ctx, func(tx *Tx) error {
		sub, err := tx.SettleSubmission(ctx, id, status, resultJSON)
		if err != nil {
			return err
		}
		out = sub
		return nil
	})
	return out, err
}

func (s *Store) GetSubmission(ctx context.Context, id string) (Submission, error) {
	sub, ok, err := s.backend.read(ctx).getSubmission(ctx, id)
	if err != nil {
		return Submission{}, err
	}
	if !ok {
		return Submission{}, fmt.Errorf("%w: submission %q", ErrNotFound, id)
	}
	return sub, nil
}

func (s *Store) GetSubmissionByRequestID(ctx context.Context, conversationID, requestID string) (Submission, error) {
	sub, ok, err := s.backend.read(ctx).getSubmissionByRequestID(ctx, conversationID, requestID)
	if err != nil {
		return Submission{}, err
	}
	if !ok {
		return Submission{}, fmt.Errorf("%w: submission (%s,%s)", ErrNotFound, conversationID, requestID)
	}
	return sub, nil
}

func (s *Store) CreateTask(ctx context.Context, task Task) (CreateTaskResult, error) {
	var out CreateTaskResult
	err := s.Mutate(ctx, func(tx *Tx) error {
		res, err := tx.CreateTask(ctx, task)
		if err != nil {
			return err
		}
		out = res
		return nil
	})
	return out, err
}

func (s *Store) GetTask(ctx context.Context, id string) (Task, error) {
	t, ok, err := s.backend.read(ctx).getTask(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if !ok {
		return Task{}, fmt.Errorf("%w: task %q", ErrNotFound, id)
	}
	return t, nil
}

func (s *Store) GetTaskByDedupKey(ctx context.Context, ownerTaskID, dedupKey string) (Task, bool, error) {
	return s.backend.read(ctx).getTaskByDedupKey(ctx, ownerTaskID, dedupKey)
}

func (s *Store) ListChildTasks(ctx context.Context, ownerTaskID string) ([]Task, error) {
	return s.backend.read(ctx).listTasksByOwner(ctx, ownerTaskID)
}

func (s *Store) ListTasksByStatus(ctx context.Context, statuses ...TaskStatus) ([]Task, error) {
	return s.backend.read(ctx).listTasksByStatus(ctx, statuses)
}

func (s *Store) ListTasksByConversation(ctx context.Context, conversationID string) ([]Task, error) {
	return s.backend.read(ctx).listTasksByConversation(ctx, conversationID)
}

func (s *Store) SendSignal(ctx context.Context, sig Signal) (SendSignalResult, error) {
	var out SendSignalResult
	err := s.Mutate(ctx, func(tx *Tx) error {
		res, err := tx.SendSignal(ctx, sig)
		if err != nil {
			return err
		}
		out = res
		return nil
	})
	return out, err
}

func (s *Store) ListSignals(ctx context.Context, taskID string, includeConsumed bool) ([]Signal, error) {
	return s.backend.read(ctx).listSignals(ctx, taskID, "", !includeConsumed)
}
