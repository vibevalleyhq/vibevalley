package observe

import "vibevalley/pkg/smith/oar"

// Tasks for a task panel (observe/tasks.ts).

// TaskView is one task as its runtime reported it: the shape a host draws for
// background commands and subagents alike. SessionID and AgentPath say whose
// task it is; StartedAt / EndedAt are the receivedAt of the reports. A root
// runtime exit also ends unfinished tasks; its receivedAt supplies that ending.
type TaskView struct {
	TaskID         string   `json:"taskId"`
	SessionID      string   `json:"sessionId"`
	AgentPath      []string `json:"agentPath"`
	TaskType       string   `json:"taskType"`
	NativeType     string   `json:"nativeType,omitempty"`
	Description    *string  `json:"description,omitempty"`
	Status         string   `json:"status"`
	Background     *bool    `json:"background,omitempty"`
	Ambient        *bool    `json:"ambient,omitempty"`
	ToolCallID     string   `json:"toolCallId,omitempty"`
	ChildSessionID string   `json:"childSessionId,omitempty"`
	Summary        string   `json:"summary,omitempty"`
	OutputFile     string   `json:"outputFile,omitempty"`
	Error          *string  `json:"error,omitempty"`
	StartedAt      *int64   `json:"startedAt,omitempty"`
	EndedAt        *int64   `json:"endedAt,omitempty"`
}

// TaskMap is tasks by id, in the order the stream first named them. Frozen once returned.
type TaskMap = *OrderedMap[TaskView]

// InitialTasks is the empty task map.
func InitialTasks() TaskMap { return NewOrderedMap[TaskView]() }

// TaskEventOrigin is where a task event was read: the record's session, agent and arrival time.
type TaskEventOrigin struct {
	SessionID  string
	AgentPath  []string
	ReceivedAt int64
}

// IsTaskEvent reports a task_started, task_updated or task_ended body.
func IsTaskEvent(body oar.EventBody) bool {
	switch body.(type) {
	case oar.TaskStarted, oar.TaskUpdated, oar.TaskEnded:
		return true
	}
	return false
}

func taskIDOf(body oar.EventBody) string {
	switch e := body.(type) {
	case oar.TaskStarted:
		return e.TaskID
	case oar.TaskUpdated:
		return e.TaskID
	case oar.TaskEnded:
		return e.TaskID
	}
	return ""
}

// placeholder: a report about a task whose start the stream does not hold
// (a mid-session subscriber, a runtime that reported no start) is still a row.
func placeholder(taskID string, origin TaskEventOrigin) TaskView {
	return TaskView{TaskID: taskID, SessionID: origin.SessionID, AgentPath: pathOrEmpty(origin.AgentPath), TaskType: "other", Status: "running"}
}

// reopened is the row without what its last end said: a task running again has no end yet.
func reopened(view TaskView) TaskView {
	view.EndedAt = nil
	view.Summary = ""
	view.OutputFile = ""
	return view
}

func applyTask(previous *TaskView, body oar.EventBody, origin TaskEventOrigin) TaskView {
	at := origin.ReceivedAt
	switch e := body.(type) {
	case oar.TaskStarted:
		fields := TaskView{TaskID: e.TaskID, SessionID: origin.SessionID, AgentPath: pathOrEmpty(origin.AgentPath), TaskType: e.TaskType,
			NativeType: e.NativeType, ToolCallID: e.ToolCallID, ChildSessionID: e.ChildSessionID, Background: e.Background, Ambient: e.Ambient}
		if e.Description != "" {
			description := e.Description
			fields.Description = &description
		}
		// A start after an earlier start is the task beginning again (claude
		// re-registers a resumed subagent); a row made from reports that came
		// before the start keeps what they said.
		if previous != nil && previous.StartedAt == nil {
			next := *previous
			next.TaskID, next.SessionID, next.AgentPath, next.TaskType = fields.TaskID, fields.SessionID, fields.AgentPath, fields.TaskType
			if fields.NativeType != "" {
				next.NativeType = fields.NativeType
			}
			if fields.Description != nil {
				next.Description = fields.Description
			}
			if fields.ToolCallID != "" {
				next.ToolCallID = fields.ToolCallID
			}
			if fields.ChildSessionID != "" {
				next.ChildSessionID = fields.ChildSessionID
			}
			if fields.Background != nil {
				next.Background = fields.Background
			}
			if fields.Ambient != nil {
				next.Ambient = fields.Ambient
			}
			next.StartedAt = &at
			return next
		}
		fields.Status = "running"
		fields.StartedAt = &at
		return fields
	case oar.TaskUpdated:
		base := placeholder(e.TaskID, origin)
		if previous != nil {
			base = *previous
		}
		if e.Status == "pending" || e.Status == "running" || e.Status == "paused" {
			base = reopened(base)
		}
		if e.Status != "" {
			base.Status = e.Status
		}
		if e.Background != nil {
			base.Background = e.Background
		}
		if e.Description != nil {
			base.Description = e.Description
		}
		if e.Error != nil {
			base.Error = e.Error
		}
		return base
	case oar.TaskEnded:
		base := placeholder(e.TaskID, origin)
		if previous != nil {
			base = *previous
		}
		base.Status = e.Status
		if e.Summary != "" {
			base.Summary = e.Summary
		}
		if e.OutputFile != "" {
			base.OutputFile = e.OutputFile
		}
		base.EndedAt = &at
		return base
	}
	if previous != nil {
		return *previous
	}
	return placeholder(taskIDOf(body), origin)
}

// ApplyTaskEvent folds one task event into the task map. Status follows the latest report.
func ApplyTaskEvent(previous TaskMap, body oar.EventBody, origin TaskEventOrigin) TaskMap {
	id := taskIDOf(body)
	var prior *TaskView
	if found, ok := previous.Get(id); ok {
		prior = &found
	}
	return orEmpty(previous).With(id, applyTask(prior, body, origin))
}

// ReduceTasks folds one record into the task map. Status follows the latest
// report: a codex subagent that completed and is then given more work reads
// as running again. Records without task events return the same map. This
// event-only reducer does not infer endings at runtime exit; use
// ReduceTaskState for that.
func ReduceTasks(previous TaskMap, record oar.RawEvent) TaskMap {
	if record.Kind != oar.KindFrame {
		return previous
	}
	next := previous
	for _, body := range record.Frame.Events {
		if IsTaskEvent(body) {
			next = ApplyTaskEvent(next, body, originOf(record))
		}
	}
	return next
}

func originOf(record oar.RawEvent) TaskEventOrigin {
	return TaskEventOrigin{SessionID: record.SessionID, AgentPath: record.AgentPath, ReceivedAt: record.ReceivedAt}
}

// TaskState is the checkpointable task fold for one runtime process, including its child sessions.
type TaskState struct {
	Tasks TaskMap
	// "" until the first record selects the root.
	RootSessionID string
	// Reuses the status fold's current-turn stop evidence.
	Status oar.AgentStatus
	// A root dispose request also applies when no turn is running.
	Disposed bool
	// Task ids whose current error was inferred from runtime exit, not reported natively.
	ExitErrors *OrderedMap[struct{}]
}

func (s TaskState) MarshalJSON() ([]byte, error) {
	out := map[string]any{"tasks": orEmpty(s.Tasks), "status": s.Status, "disposed": s.Disposed, "exitErrors": orEmpty(s.ExitErrors).Keys()}
	if out["exitErrors"] == nil {
		out["exitErrors"] = []string{}
	}
	if s.RootSessionID != "" {
		out["rootSessionId"] = s.RootSessionID
	}
	return marshalNoEscape(out)
}

// InitialTaskState starts a fresh fold per runtime start or resume. Without
// an id ("") the first record selects the root.
func InitialTaskState(rootSessionID string) TaskState {
	return TaskState{Tasks: InitialTasks(), RootSessionID: rootSessionID, Status: InitialStatus, ExitErrors: NewOrderedMap[struct{}]()}
}

func clearExitError(previous TaskState, body oar.EventBody) TaskState {
	id := taskIDOf(body)
	row, ok := previous.Tasks.Get(id)
	if update, isUpdate := body.(oar.TaskUpdated); !previous.ExitErrors.Has(id) || !ok || (isUpdate && update.Status == "" && update.Error == nil) {
		return previous
	}
	row.Error = nil
	next := previous
	next.Tasks = previous.Tasks.With(id, row)
	next.ExitErrors = previous.ExitErrors.Without(id)
	return next
}

func reduceTaskReports(previous TaskState, record oar.RawEvent) TaskState {
	if record.Kind != oar.KindFrame {
		return previous
	}
	next := previous
	for _, body := range record.Frame.Events {
		if IsTaskEvent(body) {
			next = clearExitError(next, body)
			next.Tasks = ApplyTaskEvent(next.Tasks, body, originOf(record))
		}
	}
	return next
}

func endRuntimeTasks(previous TaskState, receivedAt int64, stopped bool) TaskState {
	tasks := orEmpty(previous.Tasks).clone()
	exitErrors := orEmpty(previous.ExitErrors).clone()
	for _, id := range tasks.Keys() {
		task, _ := tasks.Get(id)
		if task.Status != "pending" && task.Status != "running" && task.Status != "paused" {
			continue
		}
		inferError := !stopped && task.Error == nil
		task.Status = "failed"
		if stopped {
			task.Status = "stopped"
		}
		at := receivedAt
		task.EndedAt = &at
		if inferError {
			message := "runtime exited"
			task.Error = &message
			exitErrors.set(id, struct{}{})
		}
		tasks.set(id, task)
	}
	next := previous
	next.Tasks = tasks
	next.ExitErrors = exitErrors
	return next
}

// ReduceTaskState folds task reports and the root process exit.
// Pending/running/paused tasks, including child tasks, end as stopped after
// dispose or an exit-aborted turn, failed otherwise. Native endings remain
// authoritative, including reports arriving after exit.
func ReduceTaskState(previous TaskState, record oar.RawEvent) TaskState {
	rootSessionID := previous.RootSessionID
	if rootSessionID == "" {
		rootSessionID = record.SessionID
	}
	root := record.SessionID == rootSessionID && len(record.AgentPath) == 0
	status := ReduceStatus(previous.Status, record, rootSessionID)
	disposed := previous.Disposed || (root && record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime && record.Request.Kind == oar.RequestDispose)
	next := previous
	next.RootSessionID, next.Status, next.Disposed = rootSessionID, status, disposed
	if root && record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
		aborted := previous.Status.IsRunning() && status.Kind == "idle" && status.LastTurnOutcome != nil && status.LastTurnOutcome.Kind == "aborted"
		return endRuntimeTasks(next, record.ReceivedAt, disposed || aborted)
	}
	return reduceTaskReports(next, record)
}

// TasksOf is the tasks in one runtime stream, including inferred endings at
// root process exit, with the seq of the last record read. Pass the root id
// when the first record is a child's ("" otherwise).
func TasksOf(records []oar.RawEvent, rootSessionID string) oar.QueryResult[[]TaskView] {
	state := InitialTaskState(rootSessionID)
	seq := int64(-1)
	for _, record := range records {
		state = ReduceTaskState(state, record)
		seq = record.Seq
	}
	values := state.Tasks.Values()
	if values == nil {
		values = []TaskView{}
	}
	return oar.QueryResult[[]TaskView]{Value: values, Seq: seq}
}
