package durable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	defaultRestartLimit = 5
	memoKeyWokenSignal  = "__durable_woken_signal"
)

// SchedulerOption configures a durable Scheduler.
type SchedulerOption func(*Scheduler)

// WithAlertSink attaches an alert observer invoked when restart_limit or governance events fire.
func WithAlertSink(sink AlertSink) SchedulerOption {
	return func(s *Scheduler) {
		s.alertSink = sink
	}
}

// WithMaxWorkers bounds concurrent active phase goroutines (defaults to 32).
func WithMaxWorkers(n int) SchedulerOption {
	return func(s *Scheduler) {
		if n > 0 {
			s.maxWorkers = n
		}
	}
}

// Scheduler drives explicit phase state machines over a durable store with zero goroutines
// held during TransSleep or TransWaitTasks, restartLimit circuit breaking, and bottom-up Abort.
type Scheduler struct {
	st         *store.Store
	clock      store.Clock
	alertSink  AlertSink
	maxWorkers int

	mu          sync.Mutex
	phases      map[string]map[string]PhaseFunc
	runningCtxs map[string]context.CancelFunc
	sleepTimers map[string]store.Timer
	waiters     map[string][]chan store.Task
	abortTrace  []string
	closed      bool

	dispatchCh    chan string
	stopCh        chan struct{}
	workerSem     chan struct{}
	activeWorkers atomic.Int64
	wg            sync.WaitGroup
	closeOnce     sync.Once
}

// NewScheduler creates a Scheduler backed by st. Call Start or Recover to begin processing tasks.
func NewScheduler(st *store.Store, opts ...SchedulerOption) *Scheduler {
	s := &Scheduler{
		st:          st,
		clock:       st.Clock(),
		maxWorkers:  32,
		phases:      make(map[string]map[string]PhaseFunc),
		runningCtxs: make(map[string]context.CancelFunc),
		sleepTimers: make(map[string]store.Timer),
		waiters:     make(map[string][]chan store.Task),
		dispatchCh:  make(chan string, 1024),
		stopCh:      make(chan struct{}),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	s.workerSem = make(chan struct{}, s.maxWorkers)
	s.wg.Add(1)
	go s.dispatchLoop()
	return s
}

// RegisterPhase binds a PhaseFunc to (taskKind, phaseName).
func (s *Scheduler) RegisterPhase(kind, phaseName string, fn PhaseFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	byPhase := s.phases[kind]
	if byPhase == nil {
		byPhase = make(map[string]PhaseFunc)
		s.phases[kind] = byPhase
	}
	byPhase[phaseName] = fn
}

// ActiveWorkers returns the number of task phase goroutines currently executing.
// Sleeping and waiting tasks hold ZERO worker goroutines.
func (s *Scheduler) ActiveWorkers() int64 {
	return s.activeWorkers.Load()
}

// AbortTrace returns the chronological IDs of tasks aborted bottom-up (children before parents).
func (s *Scheduler) AbortTrace() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.abortTrace)
}

// ClearAbortTrace resets the recorded bottom-up abort trace.
func (s *Scheduler) ClearAbortTrace() {
	s.mu.Lock()
	s.abortTrace = nil
	s.mu.Unlock()
}

// Close stops dispatching new phases, cancels active phase contexts, stops sleep timers,
// and waits for all active worker goroutines to exit cleanly.
func (s *Scheduler) Close() {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		for _, cancel := range s.runningCtxs {
			cancel()
		}
		for id, tm := range s.sleepTimers {
			tm.Stop()
			delete(s.sleepTimers, id)
		}
		s.mu.Unlock()
		close(s.stopCh)
		s.wg.Wait()
	})
}

// StartTask creates and schedules a new durable task (or returns existing if DedupKey matches).
func (s *Scheduler) StartTask(ctx context.Context, task store.Task) (store.CreateTaskResult, error) {
	if task.RestartLimit <= 0 {
		task.RestartLimit = defaultRestartLimit
	}
	if task.Status == "" {
		task.Status = store.TaskPending
	}
	res, err := s.st.CreateTask(ctx, task)
	if err != nil {
		return store.CreateTaskResult{}, err
	}
	if res.Task.Status == store.TaskPending {
		s.enqueue(res.Task.ID)
	}
	return res, nil
}

// WaitTask blocks ONLY the caller's test/API context until taskID reaches terminal state.
// Internally uses event notification channels without polling or holding scheduler goroutines.
func (s *Scheduler) WaitTask(ctx context.Context, taskID string) (store.Task, error) {
	ch := make(chan store.Task, 1)
	s.mu.Lock()
	s.waiters[taskID] = append(s.waiters[taskID], ch)
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		list := s.waiters[taskID]
		for i, c := range list {
			if c == ch {
				s.waiters[taskID] = append(list[:i], list[i+1:]...)
				break
			}
		}
		if len(s.waiters[taskID]) == 0 {
			delete(s.waiters, taskID)
		}
		s.mu.Unlock()
	}()

	cur, err := s.st.GetTask(ctx, taskID)
	if err != nil {
		return store.Task{}, err
	}
	if cur.Status == store.TaskTerminal {
		return cur, nil
	}

	select {
	case done := <-ch:
		return done, nil
	case <-s.stopCh:
		return s.st.GetTask(context.Background(), taskID)
	case <-ctx.Done():
		return store.Task{}, ctx.Err()
	}
}

// SendSignal delivers a signal atomically into durable_signal and wakes the target task if
// it is currently sleeping on that signal (or buffers it for future TransSleep if not yet sleeping).
func (s *Scheduler) SendSignal(ctx context.Context, sig store.Signal) (store.SendSignalResult, error) {
	var res store.SendSignalResult
	var wakeTaskID string
	err := s.st.Mutate(ctx, func(tx *store.Tx) error {
		sr, err := tx.SendSignal(ctx, sig)
		if err != nil {
			return err
		}
		res = sr
		if sr.Deduplicated && sr.Signal.Consumed {
			return nil
		}
		task, err := tx.GetTask(ctx, sig.TaskID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				// Early signal for a task not yet inserted or external task ID: keep buffered.
				return nil
			}
			return err
		}
		if task.Status == store.TaskSleeping && (task.WaitSignalName == "" || task.WaitSignalName == sig.SignalName) {
			popped, ok, err := tx.ConsumeFirstSignal(ctx, task.ID, sig.SignalName)
			if err != nil {
				return err
			}
			if ok {
				if err := setWokenSignalInMemo(&task, popped); err != nil {
					return err
				}
				task.Status = store.TaskPending
				task.WakeUntilMs = 0
				task.WaitSignalName = ""
				if _, err := tx.UpdateTask(ctx, task); err != nil {
					return err
				}
				wakeTaskID = task.ID
			}
		}
		return nil
	})
	if err != nil {
		return store.SendSignalResult{}, err
	}
	if wakeTaskID != "" {
		s.cancelSleepTimer(wakeTaskID)
		s.enqueue(wakeTaskID)
	}
	return res, nil
}

// AbortTask aborts taskID and all non-terminal descendants in strict bottom-up order
// (deepest leaves first, taskID last), waking any waiting owner task.
func (s *Scheduler) AbortTask(ctx context.Context, taskID, reason string) error {
	if reason == "" {
		reason = store.ReasonAborted
	}
	var abortedOrder []string
	var wokenParents []string
	var terminalNotifies []store.Task
	var alerts []Alert

	err := s.st.Mutate(ctx, func(tx *store.Tx) error {
		var err error
		abortedOrder, terminalNotifies, wokenParents, err = abortSubtreeBottomUpTx(ctx, tx, taskID, reason)
		if err != nil {
			return err
		}
		if reason == store.ReasonRestartLimit {
			rootTask, getErr := tx.GetTask(ctx, taskID)
			if getErr == nil {
				al, alErr := persistAlertTx(ctx, tx, Alert{
					Kind:           AlertRestartLimit,
					TaskID:         rootTask.ID,
					ConversationID: rootTask.ConversationID,
					Title:          "Task restart limit tripped",
					Message:        fmt.Sprintf("task %s (%s) exceeded restartLimit=%d without checkpoint progress", rootTask.ID, rootTask.Kind, rootTask.RestartLimit),
					CreatedAtMs:    tx.NowMs(),
				})
				if alErr == nil {
					alerts = append(alerts, al)
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	s.recordAbortAndCancel(abortedOrder)
	for _, t := range terminalNotifies {
		s.notifyWaiters(t)
	}
	for _, pid := range wokenParents {
		s.enqueue(pid)
	}
	for _, al := range alerts {
		s.emitAlert(al)
	}
	return nil
}

// Recover reconciles tasks persisted before a process crash:
//   - residual running/completing non-model tasks increment restart_count;
//     reaching restartLimit (default 5) trips restart_limit and performs bottom-up child Abort;
//   - sleeping tasks with buffered signals or expired WakeUntilMs wake immediately, otherwise re-arm timers;
//   - waiting tasks whose children already settled wake immediately;
//   - pending tasks are enqueued for execution.
func (s *Scheduler) Recover(ctx context.Context) error {
	var toEnqueue []string
	var toArmSleep []store.Task
	var abortedOrder []string
	var terminalNotifies []store.Task
	var alerts []Alert

	err := s.st.Mutate(ctx, func(tx *store.Tx) error {
		active, err := tx.ListTasksByStatus(ctx,
			store.TaskPending,
			store.TaskRunning,
			store.TaskSleeping,
			store.TaskWaiting,
			store.TaskCompleting,
		)
		if err != nil {
			return err
		}

		abortedSet := make(map[string]bool)
		nowMs := tx.NowMs()

		for _, t := range active {
			if abortedSet[t.ID] {
				continue
			}
			// Re-fetch latest state inside tx in case an earlier iteration mutated this task.
			cur, err := tx.GetTask(ctx, t.ID)
			if err != nil || cur.Status == store.TaskTerminal {
				continue
			}

			switch cur.Status {
			case store.TaskRunning, store.TaskCompleting:
				if !cur.IsModelTask {
					cur.RestartCount++
					limit := cur.RestartLimit
					if limit <= 0 {
						limit = defaultRestartLimit
					}
					if cur.RestartCount >= limit {
						if _, err := tx.UpdateTask(ctx, cur); err != nil {
							return err
						}
						order, termTasks, woken, err := abortSubtreeBottomUpTx(ctx, tx, cur.ID, store.ReasonRestartLimit)
						if err != nil {
							return err
						}
						for _, id := range order {
							abortedSet[id] = true
						}
						abortedOrder = append(abortedOrder, order...)
						terminalNotifies = append(terminalNotifies, termTasks...)
						toEnqueue = append(toEnqueue, woken...)

						al, err := persistAlertTx(ctx, tx, Alert{
							Kind:           AlertRestartLimit,
							TaskID:         cur.ID,
							ConversationID: cur.ConversationID,
							Title:          "Task restart limit tripped",
							Message:        fmt.Sprintf("task %s (%s) crashed %d times without advancing checkpoint (limit=%d)", cur.ID, cur.Kind, cur.RestartCount, limit),
							CreatedAtMs:    nowMs,
						})
						if err != nil {
							return err
						}
						alerts = append(alerts, al)
						continue
					}
				}
				cur.Status = store.TaskPending
				if _, err := tx.UpdateTask(ctx, cur); err != nil {
					return err
				}
				toEnqueue = append(toEnqueue, cur.ID)

			case store.TaskSleeping:
				woke := false
				if cur.WaitSignalName != "" {
					sig, ok, err := tx.ConsumeFirstSignal(ctx, cur.ID, cur.WaitSignalName)
					if err != nil {
						return err
					}
					if ok {
						if err := setWokenSignalInMemo(&cur, sig); err != nil {
							return err
						}
						cur.Status = store.TaskPending
						cur.WakeUntilMs = 0
						cur.WaitSignalName = ""
						if _, err := tx.UpdateTask(ctx, cur); err != nil {
							return err
						}
						toEnqueue = append(toEnqueue, cur.ID)
						woke = true
					}
				}
				if !woke && cur.WakeUntilMs > 0 {
					if cur.WakeUntilMs <= nowMs {
						cur.Status = store.TaskPending
						cur.WakeUntilMs = 0
						cur.WaitSignalName = ""
						if _, err := tx.UpdateTask(ctx, cur); err != nil {
							return err
						}
						toEnqueue = append(toEnqueue, cur.ID)
					} else {
						toArmSleep = append(toArmSleep, cur)
					}
				}

			case store.TaskWaiting:
				done, err := isWaitConditionSatisfiedTx(ctx, tx, cur)
				if err != nil {
					return err
				}
				if done {
					cur.Status = store.TaskPending
					if _, err := tx.UpdateTask(ctx, cur); err != nil {
						return err
					}
					toEnqueue = append(toEnqueue, cur.ID)
				}

			case store.TaskPending:
				toEnqueue = append(toEnqueue, cur.ID)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	s.recordAbortAndCancel(abortedOrder)
	for _, t := range terminalNotifies {
		s.notifyWaiters(t)
	}
	for _, al := range alerts {
		s.emitAlert(al)
	}
	for _, t := range toArmSleep {
		s.armSleepTimer(t.ID, t.WakeUntilMs)
	}
	for _, id := range toEnqueue {
		s.enqueue(id)
	}
	return nil
}

func (s *Scheduler) enqueue(taskID string) {
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return
	}
	select {
	case s.dispatchCh <- taskID:
	case <-s.stopCh:
	}
}

func (s *Scheduler) dispatchLoop() {
	defer s.wg.Done()
	for {
		var taskID string
		select {
		case taskID = <-s.dispatchCh:
		case <-s.stopCh:
			return
		}

		select {
		case s.workerSem <- struct{}{}:
		case <-s.stopCh:
			return
		}

		s.activeWorkers.Add(1)
		s.wg.Add(1)
		go func(id string) {
			defer func() {
				<-s.workerSem
				s.activeWorkers.Add(-1)
				s.wg.Done()
			}()
			s.runSinglePhase(id)
		}(taskID)
	}
}

func (s *Scheduler) runSinglePhase(taskID string) {
	var claimed store.Task
	var wokenSig *store.Signal
	var childResults []store.Task
	var shouldRun bool

	claimErr := s.st.Mutate(context.Background(), func(tx *store.Tx) error {
		t, err := tx.GetTask(context.Background(), taskID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil
			}
			return err
		}
		if t.Status != store.TaskPending {
			return nil
		}
		t.Status = store.TaskRunning
		updated, err := tx.UpdateTask(context.Background(), t)
		if err != nil {
			return err
		}
		claimed = updated
		shouldRun = true

		wokenSig, _ = popWokenSignalFromMemo(&claimed)
		if len(claimed.WaitTaskIDs) > 0 {
			for _, cid := range claimed.WaitTaskIDs {
				if ct, getErr := tx.GetTask(context.Background(), cid); getErr == nil {
					childResults = append(childResults, ct)
				}
			}
		}
		return nil
	})
	if claimErr != nil || !shouldRun {
		return
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	var handler PhaseFunc
	if byPhase := s.phases[claimed.Kind]; byPhase != nil {
		handler = byPhase[claimed.PhaseName]
	}
	phaseCtx, cancel := context.WithCancel(context.Background())
	s.runningCtxs[claimed.ID] = cancel
	s.mu.Unlock()

	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.runningCtxs, claimed.ID)
		s.mu.Unlock()
	}()

	var trans Transition
	var phaseErr error
	if handler == nil {
		trans = TransFail(store.ReasonFailed, fmt.Errorf("%w: kind=%q phase=%q", ErrPhaseNotRegistered, claimed.Kind, claimed.PhaseName))
	} else {
		tc := &TaskContext{
			sched:        s,
			task:         claimed,
			wokenSignal:  wokenSig,
			childResults: childResults,
		}
		trans, phaseErr = handler(phaseCtx, tc)
		if phaseErr != nil {
			if phaseCtx.Err() != nil {
				// Cancelled/aborted externally (or scheduler closing): do not overwrite aborted state.
				cur, getErr := s.st.GetTask(context.Background(), claimed.ID)
				if getErr == nil && cur.Status == store.TaskTerminal {
					return
				}
				if s.isClosed() {
					return
				}
			}
			trans = TransFail(store.ReasonFailed, phaseErr)
		}
	}

	// If phaseCtx was cancelled by AbortTask or Close while running, avoid stomping terminal state.
	if phaseCtx.Err() != nil && s.isClosed() {
		return
	}

	s.applyTransition(claimed.ID, trans)
}

func (s *Scheduler) applyTransition(taskID string, trans Transition) {
	var enqueueIDs []string
	var armSleep *store.Task
	var terminalNotifies []store.Task
	var abortedOrder []string

	err := s.st.Mutate(context.Background(), func(tx *store.Tx) error {
		cur, err := tx.GetTask(context.Background(), taskID)
		if err != nil {
			return err
		}
		if cur.Status == store.TaskTerminal {
			return nil
		}

		// Clear any previously delivered wake signal & wait list once the waking phase finished.
		_ = clearWokenSignalInMemo(&cur)

		if trans.HasCheckpoint {
			cpBytes, err := marshalAnyJSON(trans.Checkpoint, "{}")
			if err != nil {
				return err
			}
			cur.CheckpointJSON = cpBytes
			cur.RestartCount = 0
		}

		switch trans.Kind {
		case TransitionNext:
			if trans.NextPhase != "" && trans.NextPhase != cur.PhaseName {
				cur.RestartCount = 0
			}
			cur.PhaseName = trans.NextPhase
			cur.WaitTaskIDs = nil
			cur.WaitMode = ""
			cur.WakeUntilMs = 0
			cur.WaitSignalName = ""
			cur.Status = store.TaskPending
			if _, err := tx.UpdateTask(context.Background(), cur); err != nil {
				return err
			}
			enqueueIDs = append(enqueueIDs, cur.ID)

		case TransitionSleep:
			if trans.NextPhase != "" && trans.NextPhase != cur.PhaseName {
				cur.RestartCount = 0
				cur.PhaseName = trans.NextPhase
			}
			cur.WaitTaskIDs = nil
			cur.WaitMode = ""

			wakeMs := trans.Sleep.WakeUntilMs
			if trans.Sleep.WakeAfter > 0 {
				wakeMs = tx.NowMs() + trans.Sleep.WakeAfter.Milliseconds()
			}

			// Atomic early-signal check: if matching signal already arrived before TransSleep, wake immediately!
			if trans.Sleep.SignalName != "" {
				sig, ok, err := tx.ConsumeFirstSignal(context.Background(), cur.ID, trans.Sleep.SignalName)
				if err != nil {
					return err
				}
				if ok {
					if err := setWokenSignalInMemo(&cur, sig); err != nil {
						return err
					}
					cur.Status = store.TaskPending
					cur.WakeUntilMs = 0
					cur.WaitSignalName = ""
					if _, err := tx.UpdateTask(context.Background(), cur); err != nil {
						return err
					}
					enqueueIDs = append(enqueueIDs, cur.ID)
					return nil
				}
			}
			if trans.Sleep.WakeAfter <= 0 && wakeMs > 0 && wakeMs <= tx.NowMs() {
				cur.Status = store.TaskPending
				cur.WakeUntilMs = 0
				cur.WaitSignalName = ""
				if _, err := tx.UpdateTask(context.Background(), cur); err != nil {
					return err
				}
				enqueueIDs = append(enqueueIDs, cur.ID)
				return nil
			}

			cur.Status = store.TaskSleeping
			cur.WakeUntilMs = wakeMs
			cur.WaitSignalName = trans.Sleep.SignalName
			updated, err := tx.UpdateTask(context.Background(), cur)
			if err != nil {
				return err
			}
			if updated.WakeUntilMs > 0 {
				cp := updated
				armSleep = &cp
			}

		case TransitionWaitTasks:
			if !trans.WaitMode.Valid() {
				return fmt.Errorf("%w: %q", store.ErrInvalidWaitMode, trans.WaitMode)
			}
			if trans.NextPhase != "" && trans.NextPhase != cur.PhaseName {
				cur.RestartCount = 0
				cur.PhaseName = trans.NextPhase
			}
			cur.WakeUntilMs = 0
			cur.WaitSignalName = ""
			cur.WaitMode = trans.WaitMode
			cur.WaitTaskIDs = slices.Clone(trans.WaitTaskIDs)

			satisfied, err := isWaitConditionSatisfiedTx(context.Background(), tx, cur)
			if err != nil {
				return err
			}
			if satisfied {
				cur.Status = store.TaskPending
				if _, err := tx.UpdateTask(context.Background(), cur); err != nil {
					return err
				}
				enqueueIDs = append(enqueueIDs, cur.ID)
				return nil
			}
			cur.Status = store.TaskWaiting
			if _, err := tx.UpdateTask(context.Background(), cur); err != nil {
				return err
			}

		case TransitionComplete:
			resBytes, err := marshalAnyJSON(trans.Result, "{}")
			if err != nil {
				return err
			}
			cur.Status = store.TaskTerminal
			cur.TerminalReason = store.ReasonCompleted
			cur.ResultJSON = resBytes
			cur.ErrorText = ""
			cur.WakeUntilMs = 0
			cur.WaitSignalName = ""
			updated, err := tx.UpdateTask(context.Background(), cur)
			if err != nil {
				return err
			}
			terminalNotifies = append(terminalNotifies, updated)
			if cur.OwnerTaskID != "" {
				woken, err := maybeWakeWaitingOwnerTx(context.Background(), tx, cur.OwnerTaskID)
				if err != nil {
					return err
				}
				if woken {
					enqueueIDs = append(enqueueIDs, cur.OwnerTaskID)
				}
			}

		case TransitionFail:
			reason := trans.TerminalReason
			if reason == "" {
				reason = store.ReasonFailed
			}
			errText := ""
			if trans.Err != nil {
				errText = trans.Err.Error()
			}
			cur.ErrorText = errText
			if _, err := tx.UpdateTask(context.Background(), cur); err != nil {
				return err
			}
			order, termTasks, woken, err := abortSubtreeBottomUpTx(context.Background(), tx, cur.ID, reason)
			if err != nil {
				return err
			}
			abortedOrder = order
			enqueueIDs = append(enqueueIDs, woken...)
			terminalNotifies = append(terminalNotifies, termTasks...)
		}
		return nil
	})
	if err != nil {
		return
	}

	if len(abortedOrder) > 0 {
		s.recordAbortAndCancel(abortedOrder)
	}
	for _, t := range terminalNotifies {
		s.notifyWaiters(t)
	}
	if armSleep != nil {
		s.armSleepTimer(armSleep.ID, armSleep.WakeUntilMs)
	}
	for _, id := range enqueueIDs {
		s.enqueue(id)
	}
}

func (s *Scheduler) armSleepTimer(taskID string, wakeUntilMs int64) {
	if wakeUntilMs <= 0 {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	if prev, ok := s.sleepTimers[taskID]; ok {
		prev.Stop()
		delete(s.sleepTimers, taskID)
	}
	delayMs := wakeUntilMs - s.clock.NowMs()
	if delayMs <= 0 {
		s.mu.Unlock()
		s.wakeFromSleepTimer(taskID, wakeUntilMs)
		return
	}
	tm := s.clock.AfterFunc(time.Duration(delayMs)*time.Millisecond, func() {
		s.wakeFromSleepTimer(taskID, wakeUntilMs)
	})
	s.sleepTimers[taskID] = tm
	s.mu.Unlock()
}

func (s *Scheduler) cancelSleepTimer(taskID string) {
	s.mu.Lock()
	if tm, ok := s.sleepTimers[taskID]; ok {
		tm.Stop()
		delete(s.sleepTimers, taskID)
	}
	s.mu.Unlock()
}

func (s *Scheduler) wakeFromSleepTimer(taskID string, expectedWakeUntilMs int64) {
	s.mu.Lock()
	delete(s.sleepTimers, taskID)
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()

	var woke bool
	err := s.st.Mutate(context.Background(), func(tx *store.Tx) error {
		t, err := tx.GetTask(context.Background(), taskID)
		if err != nil {
			return nil
		}
		if t.Status != store.TaskSleeping || t.WakeUntilMs != expectedWakeUntilMs {
			return nil
		}
		t.Status = store.TaskPending
		t.WakeUntilMs = 0
		t.WaitSignalName = ""
		if _, err := tx.UpdateTask(context.Background(), t); err != nil {
			return err
		}
		woke = true
		return nil
	})
	if err == nil && woke {
		s.enqueue(taskID)
	}
}

func (s *Scheduler) recordAbortAndCancel(order []string) {
	if len(order) == 0 {
		return
	}
	s.mu.Lock()
	s.abortTrace = append(s.abortTrace, order...)
	for _, id := range order {
		if cancel, ok := s.runningCtxs[id]; ok {
			cancel()
		}
		if tm, ok := s.sleepTimers[id]; ok {
			tm.Stop()
			delete(s.sleepTimers, id)
		}
	}
	s.mu.Unlock()
}

func (s *Scheduler) notifyWaiters(t store.Task) {
	s.mu.Lock()
	list := slices.Clone(s.waiters[t.ID])
	s.mu.Unlock()
	for _, ch := range list {
		select {
		case ch <- t:
		default:
		}
	}
}

func (s *Scheduler) emitAlert(al Alert) {
	if s.alertSink != nil {
		s.alertSink.OnAlert(al)
	}
}

func (s *Scheduler) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// TaskContext provides phase-safe persistence helpers (Checkpoint, Memo, SpawnChild)
// and access to waking signals or completed child snapshots.
type TaskContext struct {
	sched        *Scheduler
	task         store.Task
	wokenSignal  *store.Signal
	childResults []store.Task
}

func (tc *TaskContext) Task() store.Task           { return tc.task }
func (tc *TaskContext) Store() *store.Store        { return tc.sched.st }
func (tc *TaskContext) Clock() store.Clock         { return tc.sched.clock }
func (tc *TaskContext) Signal() *store.Signal      { return tc.wokenSignal }
func (tc *TaskContext) ChildResults() []store.Task { return slices.Clone(tc.childResults) }

func (tc *TaskContext) UnmarshalCheckpoint(dst any) error {
	if len(tc.task.CheckpointJSON) == 0 {
		return nil
	}
	return json.Unmarshal(tc.task.CheckpointJSON, dst)
}

// Checkpoint atomically persists checkpoint progress and resets restart_count to 0.
func (tc *TaskContext) Checkpoint(ctx context.Context, data any) error {
	raw, err := marshalAnyJSON(data, "{}")
	if err != nil {
		return err
	}
	return tc.sched.st.Mutate(ctx, func(tx *store.Tx) error {
		cur, err := tx.GetTask(ctx, tc.task.ID)
		if err != nil {
			return err
		}
		cur.CheckpointJSON = raw
		cur.RestartCount = 0
		updated, err := tx.UpdateTask(ctx, cur)
		if err != nil {
			return err
		}
		tc.task = updated
		return nil
	})
}

// Memo runs fn once per key and persists its JSON result in durable_task.memo_json so
// replays after crashes reuse the memoized value without re-executing external side effects.
func (tc *TaskContext) Memo(ctx context.Context, key string, fn func() (any, error), dst any) error {
	memoMap, err := decodeMemoMap(tc.task.MemoJSON)
	if err != nil {
		return err
	}
	if existing, ok := memoMap[key]; ok {
		if dst != nil {
			return json.Unmarshal(existing, dst)
		}
		return nil
	}
	val, err := fn()
	if err != nil {
		return err
	}
	valBytes, err := marshalAnyJSON(val, "null")
	if err != nil {
		return err
	}
	err = tc.sched.st.Mutate(ctx, func(tx *store.Tx) error {
		cur, err := tx.GetTask(ctx, tc.task.ID)
		if err != nil {
			return err
		}
		m, err := decodeMemoMap(cur.MemoJSON)
		if err != nil {
			return err
		}
		m[key] = json.RawMessage(valBytes)
		encoded, err := json.Marshal(m)
		if err != nil {
			return err
		}
		cur.MemoJSON = encoded
		updated, err := tx.UpdateTask(ctx, cur)
		if err != nil {
			return err
		}
		tc.task = updated
		return nil
	})
	if err != nil {
		return err
	}
	if dst != nil {
		return json.Unmarshal(valBytes, dst)
	}
	return nil
}

// SpawnChild creates a child task owned by tc.task.ID, deduplicating on spec.DedupKey.
func (tc *TaskContext) SpawnChild(ctx context.Context, spec ChildTaskSpec) (store.Task, bool, error) {
	cpBytes, err := marshalAnyJSON(spec.Checkpoint, "{}")
	if err != nil {
		return store.Task{}, false, err
	}
	convID := spec.ConversationID
	if convID == "" {
		convID = tc.task.ConversationID
	}
	res, err := tc.sched.StartTask(ctx, store.Task{
		ConversationID: convID,
		OwnerTaskID:    tc.task.ID,
		DedupKey:       spec.DedupKey,
		Kind:           spec.Kind,
		IsModelTask:    spec.IsModelTask,
		Status:         store.TaskPending,
		PhaseName:      spec.PhaseName,
		CheckpointJSON: cpBytes,
		RestartLimit:   spec.RestartLimit,
	})
	if err != nil {
		return store.Task{}, false, err
	}
	return res.Task, res.Deduplicated, nil
}

func isWaitConditionSatisfiedTx(ctx context.Context, tx *store.Tx, parent store.Task) (bool, error) {
	if len(parent.WaitTaskIDs) == 0 {
		return true, nil
	}
	total := len(parent.WaitTaskIDs)
	terminalCount := 0
	completedCount := 0
	failedCount := 0

	for _, cid := range parent.WaitTaskIDs {
		ct, err := tx.GetTask(ctx, cid)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				terminalCount++
				failedCount++
				continue
			}
			return false, err
		}
		if ct.Status == store.TaskTerminal {
			terminalCount++
			if ct.TerminalReason == store.ReasonCompleted {
				completedCount++
			} else {
				failedCount++
			}
		}
	}

	switch parent.WaitMode {
	case store.WaitAllSettled:
		return terminalCount == total, nil
	case store.WaitFailFast:
		return failedCount > 0 || completedCount == total, nil
	case store.WaitAny:
		return completedCount > 0 || terminalCount == total, nil
	default:
		return false, fmt.Errorf("%w: %q", store.ErrInvalidWaitMode, parent.WaitMode)
	}
}

func maybeWakeWaitingOwnerTx(ctx context.Context, tx *store.Tx, ownerTaskID string) (bool, error) {
	if ownerTaskID == "" {
		return false, nil
	}
	parent, err := tx.GetTask(ctx, ownerTaskID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	if parent.Status != store.TaskWaiting {
		return false, nil
	}
	satisfied, err := isWaitConditionSatisfiedTx(ctx, tx, parent)
	if err != nil || !satisfied {
		return false, err
	}
	parent.Status = store.TaskPending
	if _, err := tx.UpdateTask(ctx, parent); err != nil {
		return false, err
	}
	return true, nil
}

// abortSubtreeBottomUpTx aborts all non-terminal descendants in post-order (children before parent)
// and finally marks rootID terminal with rootReason.
func abortSubtreeBottomUpTx(ctx context.Context, tx *store.Tx, rootID, rootReason string) (order []string, terminal []store.Task, wokenOwners []string, err error) {
	var postOrder func(id string, isRoot bool) error
	visited := make(map[string]bool)
	postOrder = func(id string, isRoot bool) error {
		if visited[id] {
			return nil
		}
		visited[id] = true

		children, err := tx.ListChildTasks(ctx, id)
		if err != nil {
			return err
		}
		for _, ch := range children {
			if err := postOrder(ch.ID, false); err != nil {
				return err
			}
		}

		cur, err := tx.GetTask(ctx, id)
		if err != nil {
			return err
		}
		if cur.Status == store.TaskTerminal {
			return nil
		}
		reason := store.ReasonAborted
		if isRoot {
			reason = rootReason
		}
		cur.Status = store.TaskTerminal
		cur.TerminalReason = reason
		cur.WakeUntilMs = 0
		cur.WaitSignalName = ""
		updated, err := tx.UpdateTask(ctx, cur)
		if err != nil {
			return err
		}
		order = append(order, updated.ID)
		terminal = append(terminal, updated)
		if isRoot && updated.OwnerTaskID != "" {
			woke, err := maybeWakeWaitingOwnerTx(ctx, tx, updated.OwnerTaskID)
			if err != nil {
				return err
			}
			if woke {
				wokenOwners = append(wokenOwners, updated.OwnerTaskID)
			}
		}
		return nil
	}

	if err := postOrder(rootID, true); err != nil {
		return nil, nil, nil, err
	}
	return order, terminal, wokenOwners, nil
}

func persistAlertTx(ctx context.Context, tx *store.Tx, al Alert) (Alert, error) {
	scopeKind := store.ScopeGlobal
	scopeID := "inbox"
	if al.ConversationID != "" {
		scopeKind = store.ScopeConversation
		scopeID = al.ConversationID
	}
	var items []Alert
	existing, err := tx.GetDocument(ctx, scopeKind, scopeID, store.DocInbox)
	if err == nil && len(existing.StateJSON) > 0 {
		var doc struct {
			Items []Alert `json:"items"`
		}
		if json.Unmarshal(existing.StateJSON, &doc) == nil {
			items = doc.Items
		}
	}
	items = append(items, al)
	raw, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		return Alert{}, err
	}
	if _, err := tx.PutDocument(ctx, scopeKind, scopeID, store.DocInbox, raw); err != nil {
		return Alert{}, err
	}
	return al, nil
}

func decodeMemoMap(raw []byte) (map[string]json.RawMessage, error) {
	if len(raw) == 0 {
		return make(map[string]json.RawMessage), nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = make(map[string]json.RawMessage)
	}
	return m, nil
}

func setWokenSignalInMemo(task *store.Task, sig store.Signal) error {
	m, err := decodeMemoMap(task.MemoJSON)
	if err != nil {
		return err
	}
	b, err := json.Marshal(sig)
	if err != nil {
		return err
	}
	m[memoKeyWokenSignal] = json.RawMessage(b)
	encoded, err := json.Marshal(m)
	if err != nil {
		return err
	}
	task.MemoJSON = encoded
	return nil
}

func popWokenSignalFromMemo(task *store.Task) (*store.Signal, error) {
	m, err := decodeMemoMap(task.MemoJSON)
	if err != nil {
		return nil, err
	}
	raw, ok := m[memoKeyWokenSignal]
	if !ok {
		return nil, nil
	}
	var sig store.Signal
	if err := json.Unmarshal(raw, &sig); err != nil {
		return nil, err
	}
	return &sig, nil
}

func clearWokenSignalInMemo(task *store.Task) error {
	m, err := decodeMemoMap(task.MemoJSON)
	if err != nil {
		return err
	}
	if _, ok := m[memoKeyWokenSignal]; !ok {
		return nil
	}
	cp := maps.Clone(m)
	delete(cp, memoKeyWokenSignal)
	encoded, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	task.MemoJSON = encoded
	return nil
}

func marshalAnyJSON(v any, fallback string) ([]byte, error) {
	if v == nil {
		return []byte(fallback), nil
	}
	switch raw := v.(type) {
	case []byte:
		if len(raw) == 0 {
			return []byte(fallback), nil
		}
		if !json.Valid(raw) {
			return nil, store.ErrInvalidArgument
		}
		cp := make([]byte, len(raw))
		copy(cp, raw)
		return cp, nil
	case json.RawMessage:
		if len(raw) == 0 {
			return []byte(fallback), nil
		}
		if !json.Valid(raw) {
			return nil, store.ErrInvalidArgument
		}
		cp := make([]byte, len(raw))
		copy(cp, raw)
		return cp, nil
	default:
		return json.Marshal(v)
	}
}
