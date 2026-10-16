package observe_test

import (
	"encoding/json"
	"os"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/tasks.test.ts

func tkFrame(seq int64, events ...oar.EventBody) oar.RawEvent {
	return oar.RawEvent{Envelope: oar.Envelope{SessionID: "root", AgentPath: []string{}, Seq: seq, ReceivedAt: seq * 10}, Kind: oar.KindFrame,
		Frame: oar.FrameBody{Type: "item/completed", Native: json.RawMessage(`{}`), Events: events}}
}

// The recorded claude stream (a background command and a background
// subagent) as records: the parity golden holds it folded through the claude
// projection (smith/parity/generate.ts), since Go has no claude projection here.
func TestTasksClaudeBackgroundCommandAndSubagent(t *testing.T) {
	data, err := os.ReadFile("../parity/golden/replay-claude-background-tasks.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Records []oar.RawEvent `json:"records"`
	}
	if err := json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	fxMatch(t, observe.TasksOf(golden.Records, "").Value, `[
		{"taskId":"bdc6lp8wy","taskType":"shell","nativeType":"local_bash","background":true,"status":"stopped","summary":"Sleep 8 seconds then print done"},
		{"taskId":"a8f6763441bcda20c","taskType":"agent","nativeType":"local_agent","background":true,"status":"completed","toolCallId":"toolu_017rmJ9ug4RCsCDqB31JdQVA"}]`)
}

func TestTasksCodexSubagentGivenMoreWorkRunsAgain(t *testing.T) {
	value := observe.TasksOf([]oar.RawEvent{
		tkFrame(0, oar.TaskStarted{TaskID: "child", TaskType: "agent", ChildSessionID: "child", Description: "/root/helper"}),
		tkFrame(1, oar.TaskEnded{TaskID: "child", Status: "completed"}),
		tkFrame(2, oar.TaskUpdated{TaskID: "child", Status: "running"}),
	}, "").Value
	fxEqual(t, value, `[{"taskId":"child","sessionId":"root","agentPath":[],"taskType":"agent","childSessionId":"child","description":"/root/helper","status":"running","startedAt":0}]`)
}

func TestTasksReportWithoutStartStillMakesARow(t *testing.T) {
	value := observe.TasksOf([]oar.RawEvent{tkFrame(0, oar.TaskEnded{TaskID: "late", Status: "failed"})}, "").Value
	fxMatch(t, value, `[{"taskId":"late","taskType":"other","status":"failed","endedAt":0}]`)
}

func TestTasksStartedAgainIsAFreshRow(t *testing.T) {
	value := observe.TasksOf([]oar.RawEvent{
		tkFrame(0, oar.TaskStarted{TaskID: "t", TaskType: "agent"}),
		tkFrame(1, oar.TaskEnded{TaskID: "t", Status: "completed", Summary: "done"}),
		tkFrame(2, oar.TaskStarted{TaskID: "t", TaskType: "agent", Background: oar.Bool(true)}),
	}, "").Value
	fxEqual(t, value, `[{"taskId":"t","sessionId":"root","agentPath":[],"taskType":"agent","background":true,"status":"running","startedAt":20}]`)
}
