package morph

import (
	"context"
	"encoding/json"
	"slices"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

const (
	pollFirst = 250 * time.Millisecond
	pollMax   = time.Second
	// Consecutive failed task queries after which an attached Console is taken for gone.
	unreachableAfter = 8
)

type tracked struct {
	taskID      string
	status      string
	approved    map[string]bool
	closeStream func()
	streaming   bool
	ended       chan struct{}
}

// tracker follows each task until it ends (tracker.ts): `/stream/ws`
// snapshots become frames as they arrive; `GET /tasks/{id}` answers become
// frames when they report a new status; the terminal one ends the turn. A
// task pending on an approval is approved (sessions run YOLO).
//
// Locking: mu is the session's lock. busy/active/follow/close are called
// with it held; the tracker's own goroutines take it before touching state,
// and release it around every network call.
type tracker struct {
	mu            *sync.Mutex
	client        *Client
	kernel        *kernel.Kernel
	topicID       string
	onIdle        func()
	onUnreachable func()

	tasks      []*tracked
	projection Projection
	closed     bool
}

func (t *tracker) busy() bool { return len(t.tasks) > 0 }

func (t *tracker) active() string {
	if len(t.tasks) == 0 {
		return ""
	}
	return t.tasks[0].taskID
}

func (t *tracker) following(task *tracked) bool {
	return !t.closed && slices.Contains(t.tasks, task)
}

// recordStream records one snapshot; under mu.
func (t *tracker) recordStream(frame json.RawMessage) {
	var events []oar.EventBody
	t.projection, events = FoldStream(t.projection, frame)
	status, ok := jsonx.ParseRecord(frame)["status"].(string)
	if !ok {
		status = "snapshot"
	}
	t.kernel.Frame(oar.FrameBody{Type: "stream/" + status, Native: frame, Events: events}, kernel.RecordAt{})
}

// approve answers a pending approval; called without mu.
func (t *tracker) approve(task *tracked, approvalID string) {
	ctx := context.Background()
	info, err := t.client.Call(ctx, "GET", "/approvals/"+urlEscape(approvalID), nil)
	if err != nil {
		return
	}
	t.mu.Lock()
	t.kernel.Request(oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: "approval", Native: info.Body}, kernel.RecordAt{ID: approvalID})
	t.mu.Unlock()
	decision, err := t.client.Call(ctx, "POST", "/approvals/"+urlEscape(approvalID)+"/approve", map[string]any{"actor": "oar", "note": "OAR sessions run without approval gates"})
	if err != nil {
		return
	}
	t.mu.Lock()
	t.kernel.Respond(approvalID, oar.ResponseBody{Kind: oar.ResponseAnswered, Native: decision.Body}, kernel.RecordAt{})
	t.mu.Unlock()
}

// finish ends a task's turn; called without mu.
func (t *tracker) finish(task *tracked, info json.RawMessage) {
	metadata, err := t.client.Call(context.Background(), "GET", "/topic/"+urlEscape(t.topicID)+"/metadata", nil)
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.following(task) {
		return
	}
	if err == nil && metadata.Status == 200 {
		t.kernel.Frame(oar.FrameBody{Type: "topic/metadata", Native: metadata.Body, Events: ContextEvents(metadata.Body)}, kernel.RecordAt{})
	}
	var events []oar.EventBody
	t.projection, events = FoldTask(t.projection, info)
	t.kernel.Frame(oar.FrameBody{Type: "task/" + task.status, Native: info, Events: events}, kernel.RecordAt{})
	task.streaming = false
	task.closeStream()
	t.tasks = slices.DeleteFunc(t.tasks, func(candidate *tracked) bool { return candidate == task })
	close(task.ended)
	if len(t.tasks) == 0 {
		t.onIdle()
	}
}

// check queries a task once; true once it ended. Called without mu.
func (t *tracker) check(task *tracked) (bool, error) {
	reply, err := t.client.Call(context.Background(), "GET", "/tasks/"+urlEscape(task.taskID), nil)
	if err != nil {
		return false, err
	}
	info := jsonx.ParseRecord(reply.Body)
	status, ok := info["status"].(string)
	if reply.Status != 200 || !ok {
		return false, nil
	}
	t.mu.Lock()
	if !t.following(task) {
		t.mu.Unlock()
		return true, nil
	}
	changed := status != task.status
	task.status = status
	if changed && !TerminalTaskStatuses[status] {
		t.kernel.Frame(oar.FrameBody{Type: "task/" + status, Native: reply.Body}, kernel.RecordAt{})
	}
	approvalID, _ := info["approval_request_id"].(string)
	needsApproval := status == "pending" && approvalID != "" && !task.approved[approvalID]
	if needsApproval {
		task.approved[approvalID] = true
	}
	t.mu.Unlock()
	if changed && TerminalTaskStatuses[status] {
		t.finish(task, reply.Body)
		return true, nil
	}
	if needsApproval {
		t.approve(task, approvalID)
	}
	return false, nil
}

func (t *tracker) poll(task *tracked) {
	wait := pollFirst
	failures := 0
	for {
		time.Sleep(wait)
		t.mu.Lock()
		following := t.following(task)
		before := task.status
		t.mu.Unlock()
		if !following {
			return
		}
		ended, err := t.check(task)
		if ended {
			return
		}
		if err != nil {
			failures++
			if failures >= unreachableAfter && t.onUnreachable != nil {
				t.mu.Lock()
				t.onUnreachable()
				t.mu.Unlock()
				return
			}
		} else {
			failures = 0
		}
		t.mu.Lock()
		same := task.status == before
		t.mu.Unlock()
		if same {
			wait = min(pollMax, wait*2)
		} else {
			wait = pollFirst
		}
	}
}

// follow follows a task until it ends; under mu.
func (t *tracker) follow(taskID string) {
	if t.closed || slices.ContainsFunc(t.tasks, func(task *tracked) bool { return task.taskID == taskID }) {
		return
	}
	task := &tracked{taskID: taskID, approved: map[string]bool{}, streaming: true, closeStream: func() {}, ended: make(chan struct{})}
	var connect func()
	connect = func() {
		closeStream := t.client.Stream(taskID, func(frame json.RawMessage) {
			t.mu.Lock()
			defer t.mu.Unlock()
			if t.following(task) {
				t.recordStream(frame)
			}
		}, func() {
			// Snapshots are a live view: reconnect while the task runs.
			t.mu.Lock()
			again := task.streaming && t.following(task)
			t.mu.Unlock()
			if again {
				time.AfterFunc(pollMax, func() {
					t.mu.Lock()
					again := task.streaming && t.following(task)
					t.mu.Unlock()
					if again {
						connect()
					}
				})
			}
		})
		t.mu.Lock()
		task.closeStream = closeStream
		t.mu.Unlock()
	}
	t.tasks = append(t.tasks, task)
	go connect()
	go t.poll(task)
}

// settle waits until every task followed now has ended, or d; called without mu.
func (t *tracker) settle(d time.Duration) {
	t.mu.Lock()
	ended := make([]chan struct{}, 0, len(t.tasks))
	for _, task := range t.tasks {
		ended = append(ended, task.ended)
	}
	t.mu.Unlock()
	deadline := time.After(d)
	for _, done := range ended {
		select {
		case <-done:
		case <-deadline:
			return
		}
	}
}

// close stops following everything; under mu.
func (t *tracker) close() {
	t.closed = true
	for _, task := range t.tasks {
		task.streaming = false
		task.closeStream()
		close(task.ended)
	}
	t.tasks = nil
}
