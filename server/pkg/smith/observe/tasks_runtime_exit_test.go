package observe_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/tasks-runtime-exit.test.ts

type trScope struct {
	sessionID string
	agentPath []string
}

func trEnvelope(seq int64, scope ...trScope) oar.Envelope {
	envelope := oar.Envelope{SessionID: "root", AgentPath: []string{}, Seq: seq, ReceivedAt: seq * 10}
	for _, s := range scope {
		if s.sessionID != "" {
			envelope.SessionID = s.sessionID
		}
		if s.agentPath != nil {
			envelope.AgentPath = s.agentPath
		}
	}
	return envelope
}

func trFrame(seq int64, events []oar.EventBody, scope ...trScope) oar.RawEvent {
	return oar.RawEvent{Envelope: trEnvelope(seq, scope...), Kind: oar.KindFrame, Frame: oar.FrameBody{Type: "native", Native: json.RawMessage(`{}`), Events: events}}
}

func trRequest(seq int64, id string, body oar.RequestBody, scope ...trScope) oar.RawEvent {
	return oar.RawEvent{Envelope: trEnvelope(seq, scope...), Kind: oar.KindRequest, ID: id, Direction: oar.ToRuntime, Request: body}
}

func trResponse(seq int64, requestID string, body oar.ResponseBody, scope ...trScope) oar.RawEvent {
	return oar.RawEvent{Envelope: trEnvelope(seq, scope...), Kind: oar.KindResponse, RequestID: requestID, Response: body}
}

func trStarted(seq int64, taskID string, scope ...trScope) oar.RawEvent {
	if taskID == "" {
		taskID = "task"
	}
	return trFrame(seq, []oar.EventBody{oar.TaskStarted{TaskID: taskID, TaskType: "shell", Background: oar.Bool(true)}}, scope...)
}

func trExit(seq int64, scope ...trScope) oar.RawEvent {
	code := 9
	return trResponse(seq, "", oar.ExitedBody(&code), scope...)
}

var (
	trPrompt         = trRequest(0, "prompt", oar.RequestBody{Kind: oar.RequestPrompt, Input: "work"})
	trAcceptedPrompt = trResponse(1, "prompt", oar.Accepted())
	trAbort          = trRequest(3, "abort", oar.RequestBody{Kind: oar.RequestAbort})
	trAcceptedAbort  = trResponse(4, "abort", oar.Accepted())
	trDispose        = trRequest(3, "dispose", oar.RequestBody{Kind: oar.RequestDispose})
)

func trCompleted(seq int64) oar.RawEvent {
	return trFrame(seq, []oar.EventBody{oar.TurnEnded{Outcome: oar.Completed()}})
}

type trCause struct {
	name    string
	records []oar.RawEvent
	status  string
}

func trCauses() []trCause {
	return []trCause{
		{"accepted abort", []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trAbort, trAcceptedAbort}, "stopped"},
		{"dispose while idle", []oar.RawEvent{trStarted(2, ""), trDispose}, "stopped"},
		{"unrequested exit", []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, "")}, "failed"},
		{"unanswered abort", []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trAbort}, "failed"},
		{"refused abort", []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trAbort, trResponse(4, "abort", oar.Rejected(oar.CodeRuntimeRefused, "no"))}, "failed"},
		{"native end before exit after abort", []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trAbort, trAcceptedAbort, trCompleted(5)}, "failed"},
		{"native end before exit after dispose", []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trDispose, trCompleted(5)}, "stopped"},
	}
}

func trWith(records []oar.RawEvent, more ...oar.RawEvent) []oar.RawEvent {
	return append(append([]oar.RawEvent{}, records...), more...)
}

func TestTaskExitEndsUnfinishedTasks(t *testing.T) {
	for _, cause := range trCauses() {
		t.Run(cause.name, func(t *testing.T) {
			before := observe.TasksOf(cause.records, "")
			if before.Value[0].Status != "running" {
				t.Fatalf("before exit: %s", before.Value[0].Status)
			}
			ended := observe.TasksOf(trWith(cause.records, trExit(10)), "")
			errorField := ""
			if cause.status == "failed" {
				errorField = `,"error":"runtime exited"`
			}
			fxEqual(t, ended.Value, fmt.Sprintf(`[{"taskId":"task","taskType":"shell","background":true,"sessionId":"root","agentPath":[],"status":%q,"startedAt":20,"endedAt":100%s}]`, cause.status, errorField))
			if ended.Seq != 10 {
				t.Fatalf("seq = %d", ended.Seq)
			}
			if before.Value[0].Status != "running" {
				t.Fatal("the earlier result changed")
			}
		})
	}
}

func TestTaskUnfinishedStatusEndsAtExit(t *testing.T) {
	for _, status := range []string{"pending", "running", "paused"} {
		records := []oar.RawEvent{trStarted(0, ""), trFrame(1, []oar.EventBody{oar.TaskUpdated{TaskID: "task", Status: status}}), trExit(2)}
		fxEqual(t, observe.TasksOf(records, "").Value[0], `{"agentPath":[],"background":true,"endedAt":20,"error":"runtime exited","sessionId":"root","startedAt":0,"status":"failed","taskId":"task","taskType":"shell"}`, status)
	}
}

func TestTaskAlreadyEndedStaysUnchangedAtExit(t *testing.T) {
	for _, status := range []string{"completed", "failed", "stopped"} {
		records := []oar.RawEvent{trStarted(0, ""), trFrame(1, []oar.EventBody{oar.TaskEnded{TaskID: "task", Status: status, Summary: "native end", OutputFile: "/tmp/result"}})}
		fxEqual(t, observe.TasksOf(trWith(records, trDispose, trExit(10)), "").Value, fxShow(fxAny(t, observe.TasksOf(records, "").Value)), status)
	}
}

func TestTaskRootExitEndsChildTasksChildExitsDoNot(t *testing.T) {
	records := []oar.RawEvent{trStarted(0, ""), trStarted(1, "child", trScope{sessionID: "child"}), trStarted(2, "nested", trScope{agentPath: []string{"worker"}}),
		trExit(3, trScope{sessionID: "child"}), trExit(4, trScope{agentPath: []string{"worker"}})}
	var statuses []string
	for _, task := range observe.TasksOf(records, "").Value {
		statuses = append(statuses, task.Status)
	}
	fxEqual(t, statuses, `["running","running","running"]`)
	var rows [][]any
	for _, task := range observe.TasksOf(trWith(records, trExit(5)), "").Value {
		rows = append(rows, []any{task.TaskID, task.SessionID, task.AgentPath, task.Status, task.EndedAt, task.Error})
	}
	fxEqual(t, rows, `[["task","root",[],"failed",50,"runtime exited"],["child","child",[],"failed",50,"runtime exited"],["nested","root",["worker"],"failed",50,"runtime exited"]]`)
}

func TestTaskNativeTurnEndLeavesBackgroundTasksRunning(t *testing.T) {
	for _, outcome := range []oar.TurnOutcome{oar.AbortedOutcome(), oar.Completed()} {
		records := []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trAbort, trAcceptedAbort, trFrame(5, []oar.EventBody{oar.TurnEnded{Outcome: outcome}})}
		if got := observe.TasksOf(records, "").Value[0].Status; got != "running" {
			t.Errorf("%s: %s", outcome.Kind, got)
		}
		if got := observe.TasksOf(trWith(records, trExit(6)), "").Value[0].Status; got != "failed" {
			t.Errorf("%s after exit: %s", outcome.Kind, got)
		}
	}
}

func TestTaskLateNativeEndOverridesInferredEnd(t *testing.T) {
	for _, cause := range trCauses() {
		after := observe.TasksOf(trWith(cause.records, trExit(10), trFrame(11, []oar.EventBody{oar.TaskEnded{TaskID: "task", Status: "completed", Summary: "native result"}})), "")
		fxEqual(t, after.Value[0], `{"agentPath":[],"background":true,"endedAt":110,"sessionId":"root","startedAt":20,"status":"completed","summary":"native result","taskId":"task","taskType":"shell"}`, cause.name)
	}
}

func TestTaskLateRunningUpdateReopensWithoutInferredError(t *testing.T) {
	after := observe.TasksOf([]oar.RawEvent{trStarted(0, ""), trExit(1), trFrame(2, []oar.EventBody{oar.TaskUpdated{TaskID: "task", Status: "running", Description: oar.String("still alive")}})}, "")
	fxEqual(t, after.Value[0], `{"agentPath":[],"background":true,"description":"still alive","sessionId":"root","startedAt":0,"status":"running","taskId":"task","taskType":"shell"}`)
}

func TestTaskChildDisposeAndAbortDoNotMarkRootExitStopped(t *testing.T) {
	child := trScope{sessionID: "child"}
	records := []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trRequest(3, "dispose", oar.RequestBody{Kind: oar.RequestDispose}, child),
		trRequest(4, "abort", oar.RequestBody{Kind: oar.RequestAbort}, child), trResponse(5, "abort", oar.Accepted(), child), trExit(6)}
	if got := observe.TasksOf(records, "").Value[0].Status; got != "failed" {
		t.Fatalf("status = %s", got)
	}
}

// structuredClone checkpoints: a Go TaskState is an immutable value (its maps
// are frozen once returned), so the checkpoint is the state itself; the test
// checks the reduce leaves it unchanged.
func TestTaskIncrementalCheckpointsRetainEvidence(t *testing.T) {
	for _, cause := range trCauses() {
		state := observe.InitialTaskState("")
		for _, record := range cause.records {
			state = observe.ReduceTaskState(state, record)
		}
		before := fxShow(fxAny(t, state))
		after := observe.ReduceTaskState(state, trExit(10))
		fxEqual(t, after.Tasks.Values(), fxShow(fxAny(t, observe.TasksOf(trWith(cause.records, trExit(10)), "").Value)), cause.name)
		if task, _ := after.Tasks.Get("task"); task.Status != cause.status {
			t.Errorf("%s: %s", cause.name, task.Status)
		}
		fxEqual(t, state, before, cause.name, ": the checkpoint is unchanged")
	}
}

func TestTaskExplicitRootLetsCheckpointBeginWithChild(t *testing.T) {
	records := []oar.RawEvent{trStarted(0, "child", trScope{sessionID: "child"}), trExit(1, trScope{sessionID: "child"}), trDispose, trExit(4)}
	state := observe.InitialTaskState("root")
	for _, record := range records {
		state = observe.ReduceTaskState(state, record)
	}
	task, _ := state.Tasks.Get("child")
	if task.Status != "stopped" || task.EndedAt == nil || *task.EndedAt != 40 {
		t.Fatalf("child = %+v", task)
	}
	fxEqual(t, state.Tasks.Values(), fxShow(fxAny(t, observe.TasksOf(records, "root").Value)))
}

func TestTaskPreviousTurnAbortDoesNotStopNewTurnTasks(t *testing.T) {
	for _, answer := range []string{"accepted", "pending"} {
		records := []oar.RawEvent{trPrompt, trAcceptedPrompt, trAbort}
		if answer == "accepted" {
			records = append(records, trAcceptedAbort)
		}
		records = append(records, trCompleted(5), trRequest(6, "next", oar.RequestBody{Kind: oar.RequestPrompt, Input: "again"}), trResponse(7, "next", oar.Accepted()), trStarted(8, ""))
		if answer == "pending" {
			records = append(records, trResponse(9, "abort", oar.Accepted()))
		}
		records = append(records, trExit(10))
		if got := observe.TasksOf(records, "").Value[0].Status; got != "failed" {
			t.Errorf("%s: %s", answer, got)
		}
	}
}

func TestTaskEventOnlyReducerKeepsRowsAtExit(t *testing.T) {
	records := []oar.RawEvent{trPrompt, trAcceptedPrompt, trStarted(2, ""), trAbort, trAcceptedAbort}
	tasks := observe.InitialTasks()
	for _, record := range records {
		tasks = observe.ReduceTasks(tasks, record)
	}
	if observe.ReduceTasks(tasks, trExit(5)) != tasks {
		t.Fatal("an exit must return the same map")
	}
	if task, _ := tasks.Get("task"); task.Status != "running" {
		t.Fatalf("status = %s", task.Status)
	}
	if got := observe.TasksOf(trWith(records, trExit(5)), "").Value[0].Status; got != "stopped" {
		t.Fatalf("tasksOf = %s", got)
	}
}

func trFold(state observe.TaskState, records ...oar.RawEvent) observe.TaskState {
	for _, record := range records {
		state = observe.ReduceTaskState(state, record)
	}
	return state
}

func TestTaskNativeErrorSurvivesExitAndCompletion(t *testing.T) {
	for _, nativeError := range []string{"native failure", "runtime exited"} {
		state := trFold(observe.InitialTaskState(""), trStarted(0, ""), trFrame(1, []oar.EventBody{oar.TaskUpdated{TaskID: "task", Error: oar.String(nativeError)}}), trExit(2))
		if task, _ := state.Tasks.Get("task"); task.Error == nil || *task.Error != nativeError {
			t.Errorf("%s: error %v", nativeError, task.Error)
		}
		if state.ExitErrors.Has("task") {
			t.Errorf("%s: inferred provenance", nativeError)
		}
		ended := observe.ReduceTaskState(state, trFrame(3, []oar.EventBody{oar.TaskEnded{TaskID: "task", Status: "completed"}}))
		if task, _ := ended.Tasks.Get("task"); task.Error == nil || *task.Error != nativeError || task.Status != "completed" {
			t.Errorf("%s: ended %+v", nativeError, task)
		}
	}
}

func TestTaskLateNativeErrorReplacesInferredProvenance(t *testing.T) {
	for _, nativeError := range []string{"native failure", "runtime exited"} {
		inferred := trFold(observe.InitialTaskState(""), trStarted(0, ""), trExit(1))
		reported := observe.ReduceTaskState(inferred, trFrame(2, []oar.EventBody{oar.TaskUpdated{TaskID: "task", Error: oar.String(nativeError)}}))
		if reported.ExitErrors.Has("task") {
			t.Errorf("%s: still inferred", nativeError)
		}
		ended := observe.ReduceTaskState(reported, trFrame(3, []oar.EventBody{oar.TaskEnded{TaskID: "task", Status: "completed"}}))
		if task, _ := ended.Tasks.Get("task"); task.Error == nil || *task.Error != nativeError {
			t.Errorf("%s: ended error %v", nativeError, task.Error)
		}
		if !inferred.ExitErrors.Has("task") {
			t.Errorf("%s: the earlier checkpoint changed", nativeError)
		}
	}
}

func TestTaskMetadataOnlyUpdatesRetainInferredFailure(t *testing.T) {
	inferred := trFold(observe.InitialTaskState(""), trStarted(0, ""), trExit(1))
	described := observe.ReduceTaskState(inferred, trFrame(2, []oar.EventBody{oar.TaskUpdated{TaskID: "task", Description: oar.String("more detail")}}))
	if task, _ := described.Tasks.Get("task"); task.Error == nil || *task.Error != "runtime exited" {
		t.Fatalf("described error %v", task.Error)
	}
	if !described.ExitErrors.Has("task") {
		t.Fatal("described lost provenance")
	}
	reported := observe.ReduceTaskState(described, trFrame(3, []oar.EventBody{oar.TaskUpdated{TaskID: "task", Status: "completed"}}))
	task, _ := reported.Tasks.Get("task")
	if task.Error != nil || task.Description == nil || *task.Description != "more detail" || reported.ExitErrors.Has("task") {
		t.Fatalf("reported %+v", task)
	}
	if task, _ := described.Tasks.Get("task"); task.Status != "failed" {
		t.Fatalf("described changed: %s", task.Status)
	}
}

func TestTaskFreshRuntimeFoldDoesNotInheritDispose(t *testing.T) {
	earlier := trFold(observe.InitialTaskState("root"), trStarted(0, ""), trDispose, trExit(4))
	fresh := observe.InitialTaskState("root")
	fresh.Tasks = earlier.Tasks
	fresh = trFold(fresh, trStarted(0, "new"), trExit(1))
	old, _ := earlier.Tasks.Get("task")
	got, _ := fresh.Tasks.Get("task")
	fxEqual(t, got, fxShow(fxAny(t, old)))
	if task, _ := fresh.Tasks.Get("new"); task.Status != "failed" {
		t.Fatalf("new = %s", task.Status)
	}
}
