package brain

// Moves the agent's task graph along: a helper's task whose waits are settled goes to a helper in the background, at
// most max at once; what the helper says comes back to the agent as an input (Later: it starts a run when idle, waits
// for the end of the one under way otherwise). The agent's own tasks are its to do; nothing here does them.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"

	"vibevalley/internal/task/engine"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/x/str"
)

type taskRunner struct {
	store engine.Store
	// nil: this agent cannot send helpers (a helper itself, or the manager); a helper's task is refused when split.
	helper func(ctx context.Context, brief, label string) (string, error)
	max    int
	tell   func(text string)
	life   context.Context

	mu sync.Mutex
	// The helpers out now, by task id.
	out  map[string]context.CancelFunc
	done sync.WaitGroup
	// The graph as last reminded of, and how many times running it stayed so.
	nudged    string
	nudges    int
	maxNudges int
}

func newTaskRunner(life context.Context, store engine.Store, helper func(context.Context, string, string) (string, error), max int, tell func(string)) *taskRunner {
	if max == 0 {
		max = 3
	}
	return &taskRunner{store: store, helper: helper, max: max, tell: tell, life: life, out: map[string]context.CancelFunc{}}
}

// Sends out what is ready and fits. Called after the graph changes and when a helper comes back.
func (r *taskRunner) advance() {
	if r.helper == nil || r.life.Err() != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var picked []engine.Task
	_, err := r.store.Change(r.life, func(g []engine.Task) ([]engine.Task, error) {
		picked = nil
		room := r.max - len(r.out)
		for _, t := range engine.Ready(g) {
			if room <= 0 {
				break
			}
			if t.By != engine.ByHelper || r.out[t.ID] != nil {
				continue
			}
			g = engine.Begin(g, t.ID)
			picked = append(picked, t)
			room--
		}
		if len(picked) == 0 {
			return nil, errUnchanged
		}
		return g, nil
	})
	if errors.Is(err, errUnchanged) {
		return
	}
	if err != nil {
		log.Printf("agent: cannot move the task graph: %v", err)
		return
	}
	for _, t := range picked {
		ctx, cancel := context.WithCancel(r.life)
		r.out[t.ID] = cancel
		r.done.Add(1)
		go r.run(ctx, t)
	}
}

func (r *taskRunner) run(ctx context.Context, t engine.Task) {
	defer r.done.Done()
	said, err := r.helper(ctx, t.Brief, t.Title)
	r.mu.Lock()
	delete(r.out, t.ID)
	r.mu.Unlock()
	if ctx.Err() != nil {
		// Stopped: stop puts it back to waiting.
		return
	}
	result := said
	if err != nil {
		result = err.Error()
	}
	g, cerr := r.store.Change(r.life, func(g []engine.Task) ([]engine.Task, error) { return engine.Settle(g, t.ID, result, err != nil), nil })
	if cerr != nil {
		log.Printf("agent: cannot record task %s: %v", t.ID, cerr)
		return
	}
	state := engine.Failed
	for _, x := range g {
		if x.ID == t.ID {
			state = x.State
		}
	}
	switch state {
	case engine.Done:
		r.tell("〔任务〕" + t.ID + "（" + t.Title + "）帮手做完了：\n" + str.Trim(said) + "\n\n" + engine.Text(g))
	case engine.Failed:
		r.tell("〔任务〕" + t.ID + "（" + t.Title + "）帮手没做成：" + str.Head(result, 400) + "\n改了 brief 把它写回 waiting 重来，或者标 skipped。\n\n" + engine.Text(g))
	}
	r.advance()
}

// Calls the helpers back; their tasks wait again. The graph stays as it is otherwise.
func (r *taskRunner) stop() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.out))
	for id, cancel := range r.out {
		cancel()
		ids = append(ids, id)
	}
	r.out = map[string]context.CancelFunc{}
	r.mu.Unlock()
	r.done.Wait()
	if len(ids) == 0 {
		return
	}
	// The agent's own context may be ending (Close); the requeue still has to land.
	if _, err := r.store.Change(context.WithoutCancel(r.life), func(g []engine.Task) ([]engine.Task, error) { return engine.Requeue(g, ids), nil }); err != nil {
		log.Printf("agent: cannot put stopped tasks back: %v", err)
	}
}

// At start: a task left working by a process that went is waiting again, and goes out once more.
func (r *taskRunner) recover() {
	if _, err := r.store.Change(r.life, func(g []engine.Task) ([]engine.Task, error) {
		next := engine.Requeue(g, nil)
		if slices.Equal(engine.States(next), engine.States(g)) {
			return nil, errUnchanged
		}
		return next, nil
	}); err != nil && !errors.Is(err, errUnchanged) {
		log.Printf("agent: cannot read the task graph: %v", err)
		return
	}
	r.advance()
}

// Returned from a change that found nothing to change: nothing is written, and no TasksChanged goes out.
var errUnchanged = errors.New("unchanged")

func taskMessage(text string) CustomMessage { return NewCustomMessage("task", ai.StringContent(text)) }

// Records every change, whoever makes it, as a TasksChanged.
type watchedStore struct {
	engine.Store
	changed func([]engine.Task)
}

func (w watchedStore) Change(ctx context.Context, f func([]engine.Task) ([]engine.Task, error)) ([]engine.Task, error) {
	g, err := w.Store.Change(ctx, f)
	if err == nil {
		w.changed(g)
	}
	return g, err
}

// The open graph for a fold's summary: what the turns it replaces showed.
func (r *taskRunner) summary() string {
	g, err := r.store.Load(r.life)
	if err != nil || len(g) == 0 {
		return ""
	}
	return "【整理对话时的任务，以 tasks 为准】\n" + engine.Text(g)
}

// What to remind a run that stopped of: its own tasks that are ready, unless the graph has not moved through
// maxNudges reminders already (it is stuck; the owner or another input will move it). "" for nothing.
func (r *taskRunner) nudge() string {
	g, err := r.store.Load(r.life)
	if err != nil {
		return ""
	}
	var own []string
	for _, t := range engine.Ready(g) {
		if t.By == engine.BySelf {
			own = append(own, t.ID)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(own) == 0 {
		r.nudged, r.nudges = "", 0
		return ""
	}
	seen := engine.Text(g)
	if seen != r.nudged {
		r.nudged, r.nudges = seen, 0
	}
	max := r.maxNudges
	if max == 0 {
		max = 3
	}
	if r.nudges >= max {
		return ""
	}
	r.nudges++
	return fmt.Sprintf("〔任务〕这一轮停了，还有 %d 件你可以做：%s。接着做；做不了的用 task_update 标 failed 或 skipped，写明原因。\n\n%s", len(own), strings.Join(own, "、"), seen)
}
