package observe_test

import (
	"sync"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/smith/observe"
)

// The observe-fold assertions of tests/scripted-tasks.test.ts and
// tests/scripted-withdraw.test.ts, over the scripted runtime.

func sfOpen(t *testing.T, turn func(*oartest.Turn) error) oar.Session {
	t.Helper()
	session, err := oartest.Runtime(oartest.Options{Turn: turn}).Session(fxCtx(t), oar.AvailableInstallation{Via: "bundled"}, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Dispose(fxCtx(t)) })
	return session
}

func TestScriptedTaskOutlivesItsTurnInTasksOf(t *testing.T) {
	var mu sync.Mutex
	var started []oartest.Task
	session := sfOpen(t, func(turn *oartest.Turn) error {
		task := turn.Task(oartest.TaskSpec{TaskType: "shell", Description: "sleep 8", Background: oar.Bool(true)})
		mu.Lock()
		started = append(started, task)
		mu.Unlock()
		turn.Say("started it")
		return nil
	})
	prompted, err := session.Prompt(fxCtx(t), "start a background job", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := observe.AwaitTurnEnd(fxCtx(t), session, prompted.Seq, ""); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	task := started[0]
	mu.Unlock()
	fxMatch(t, observe.TasksOf(session.Records(), "").Value, `[{"taskId":"`+task.ID()+`","taskType":"shell","background":true,"status":"running"}]`)
	task.Update("", oar.String("sleep 8, half way"))
	task.End("completed", "slept", "/tmp/out.txt")
	task.End("failed", "", "")
	fxMatch(t, observe.TasksOf(session.Records(), "").Value, `[{"status":"completed","summary":"slept","outputFile":"/tmp/out.txt","description":"sleep 8, half way"}]`)
	if kind := session.Status().Value.Kind; kind != "idle" {
		t.Fatalf("status = %s", kind)
	}
}

func TestScriptedWithdrawnInputFoldsAsWithdrawn(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var ran []string
	session := sfOpen(t, func(turn *oartest.Turn) error {
		mu.Lock()
		ran = append(ran, turn.Input)
		mu.Unlock()
		select {
		case <-release:
		case <-turn.Context.Done():
		}
		turn.Say("echo:" + turn.Input)
		return nil
	})
	first, err := session.Prompt(fxCtx(t), "first", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := session.Queue(fxCtx(t), "later", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	withdrawn, err := session.Withdraw(fxCtx(t), queued.Request.Request.InputID)
	if err != nil || !withdrawn.IsAccepted() {
		t.Fatalf("withdraw = %+v %v", withdrawn, err)
	}
	close(release)
	if _, err := observe.AwaitTurnEnd(fxCtx(t), session, first.Seq, ""); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	fxEqual(t, ran, `["first"]`)
	mu.Unlock()
	if kind := session.Status().Value.Kind; kind != "idle" {
		t.Fatalf("status = %s", kind)
	}
	rows := [][]string{}
	for _, input := range observe.ConversationOf(session.Records()).Inputs.Values() {
		rows = append(rows, []string{input.Input, input.State})
	}
	fxEqual(t, rows, `[["first","accepted"],["later","withdrawn"]]`)
}
