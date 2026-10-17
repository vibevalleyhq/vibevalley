package manager

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	vvagent "vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func evalDecode(t *testing.T, raw json.RawMessage) agentcore.AgentMessage {
	t.Helper()
	m, err := vvagent.DecodeMessage(raw)
	if err != nil {
		t.Fatalf("%v: %s", err, raw)
	}
	return m
}

func evalDecodeAll(t *testing.T, raws []json.RawMessage) []agentcore.AgentMessage {
	t.Helper()
	out := make([]agentcore.AgentMessage, len(raws))
	for i, raw := range raws {
		out[i] = evalDecode(t, raw)
	}
	return out
}

func evalAsked(t *testing.T, w *managerWorld, words string) protocol.SessionEvent {
	t.Helper()
	return testkit.Await(t, "the step it was asked", func() (protocol.SessionEvent, bool) {
		for _, e := range w.f.Session.Events(protocol.ManagerAgent, "") {
			if e.Type == protocol.SessionEventTypeUserMessage && strings.Contains(e.Text, words) {
				return e, true
			}
		}
		return protocol.SessionEvent{}, false
	})
}

func evalRead(t *testing.T, file string) managerEval {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var eval managerEval
	if err := json.Unmarshal(data, &eval); err != nil {
		t.Fatal(err)
	}
	return eval
}

func TestManagerMarkWrongSavesTheTurnAsACase(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	if _, err := f.Memory.WriteManager("提交信息写中文"); err != nil {
		t.Fatal(err)
	}
	if err := f.Manager.Say(w.ctx, "帮我在 demo 里加个 README", "", nil, ""); err != nil {
		t.Fatal(err)
	}
	w.managerSaid(t, 1)
	if err := f.Manager.Say(w.ctx, "今天怎么样", "", nil, ""); err != nil {
		t.Fatal(err)
	}
	w.managerSaid(t, 2)
	testkit.Settle()

	first := evalAsked(t, w, "加个 README")
	got, err := f.Manager.MarkWrong(first.Seq, "  先问主人是哪个项目  ")
	if err != nil {
		t.Fatal(err)
	}
	if got.File != filepath.Join(f.Home, protocol.ManagerAgent, "evals", got.ID+".json") {
		t.Fatalf("file %q", got.File)
	}
	eval := evalRead(t, got.File)
	if eval.ID != got.ID || eval.Want != "先问主人是哪个项目" || eval.Model != w.faux.GetModel().ID || eval.Created == 0 {
		t.Fatalf("case %+v", eval)
	}
	if !strings.Contains(eval.Memory, "提交信息写中文") || !slices.Contains(eval.Tools, "dispatch") || !slices.Contains(eval.Tools, "remember") {
		t.Fatalf("memory %q, tools %v", eval.Memory, eval.Tools)
	}
	if len(eval.Before) != 0 || eval.Expect == nil || len(eval.Expect) != 0 {
		t.Fatalf("before %s, expect %v", eval.Before, eval.Expect)
	}
	input := evalDecode(t, eval.Input)
	if !managerIsInput(input) || !strings.Contains(vvagent.MessageText(input), "[来源：主人]\n主人说：帮我在 demo 里加个 README") {
		t.Fatalf("input %s", eval.Input)
	}
	did := evalDecodeAll(t, eval.Did)
	roles := make([]string, len(did))
	for i, m := range did {
		roles[i] = m.Role()
	}
	if !slices.Equal(roles, []string{"assistant", "toolResult", "assistant"}) {
		t.Fatalf("did %v", roles)
	}
	if call := did[0].(ai.AssistantMessage).Content[0]; call.Type != ai.TypeToolCall || call.Name != "dispatch" {
		t.Fatalf("call %+v", call)
	}
	if vvagent.MessageText(did[2]) != "好，已在了" {
		t.Fatalf("answer %q", vvagent.MessageText(did[2]))
	}

	second := evalAsked(t, w, "今天怎么样")
	got, err = f.Manager.MarkWrong(second.Seq, "说一句地里的进展")
	if err != nil {
		t.Fatal(err)
	}
	eval = evalRead(t, got.File)
	before := evalDecodeAll(t, eval.Before)
	if len(before) != 4 || !managerIsInput(before[0]) || vvagent.MessageText(before[3]) != "好，已在了" {
		t.Fatalf("before %s", eval.Before)
	}
	if input := evalDecode(t, eval.Input); !strings.Contains(vvagent.MessageText(input), "[来源：主人]\n主人说：今天怎么样") {
		t.Fatalf("input %s", eval.Input)
	}
	if did := evalDecodeAll(t, eval.Did); len(did) != 1 || vvagent.MessageText(did[0]) != "收到" {
		t.Fatalf("did %s", eval.Did)
	}

	var missing protocol.Missing
	if _, err := f.Manager.MarkWrong(9999, "x"); !errors.As(err, &missing) {
		t.Fatalf("no such step: %v", err)
	}
	said := slices.IndexFunc(f.Session.Events(protocol.ManagerAgent, ""), func(e protocol.SessionEvent) bool {
		return e.Type == protocol.SessionEventTypeAssistantMessage
	})
	if _, err := f.Manager.MarkWrong(f.Session.Events(protocol.ManagerAgent, "")[said].Seq, "x"); err == nil {
		t.Fatal("a step it said was taken as a turn")
	}
	if _, err := f.Manager.MarkWrong(first.Seq, " "); err == nil {
		t.Fatal("marked without what it should have done")
	}
}

// Asked while its brain could not start, the line is in its log but never reached its conversation.
func TestManagerMarkWrongRefusesALineItNeverHeard(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	if err := f.Manager.Say(w.ctx, "第一句", "", nil, ""); err != nil {
		t.Fatal(err)
	}
	w.managerSaid(t, 1)
	testkit.Settle()
	f.Manager.trace.Asked("没送到的一句", nil)
	if _, err := f.Manager.MarkWrong(evalAsked(t, w, "没送到的一句").Seq, "x"); err == nil || !strings.Contains(err.Error(), "没进管家的对话") {
		t.Fatalf("err %v", err)
	}
}
