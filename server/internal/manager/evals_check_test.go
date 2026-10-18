package manager

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	vvagent "vibevalley/internal/agent/brain"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const (
	evalCalled    = "called"
	evalNotCalled = "notCalled"
	evalSilent    = "silent"
	evalSays      = "says"
	evalSaysNot   = "saysNot"
)

// Every kind evalCheck knows: TestEvalCheckJudgesEveryKind goes through them.
var evalKinds = []string{evalCalled, evalNotCalled, evalSilent, evalSays, evalSaysNot}

// "" when it is whole: the fields its kind reads are there.
func evalProblem(e evalExpect) string {
	switch e.Kind {
	case evalCalled, evalNotCalled:
		if e.Tool == "" {
			return e.Kind + " without a tool"
		}
	case evalSays, evalSaysNot:
		if e.Contains == "" {
			return e.Kind + " without contains"
		}
	case evalSilent:
	default:
		return fmt.Sprintf("unknown kind %q", e.Kind)
	}
	return ""
}

func evalCalls(turn []agentcore.AgentMessage) []ai.Content {
	var out []ai.Content
	for _, m := range turn {
		if a, ok := m.(ai.AssistantMessage); ok {
			for _, c := range a.Content {
				if c.Type == ai.TypeToolCall {
					out = append(out, c)
				}
			}
		}
	}
	return out
}

// What it said in the turn, each message's words on a line.
func evalWords(turn []agentcore.AgentMessage) string {
	var said []string
	for _, m := range turn {
		if a, ok := m.(ai.AssistantMessage); ok {
			if text := strings.TrimSpace(vvagent.MessageText(a)); text != "" {
				said = append(said, text)
			}
		}
	}
	return strings.Join(said, "\n")
}

// The expectations the turn does not meet, each as it is written; none when it passes.
func evalCheck(expect []evalExpect, turn []agentcore.AgentMessage) []string {
	calls, words := evalCalls(turn), evalWords(turn)
	called := func(e evalExpect) bool {
		return slices.ContainsFunc(calls, func(c ai.Content) bool {
			return c.Name == e.Tool && strings.Contains(string(c.Args()), e.ArgContains)
		})
	}
	var missed []string
	for _, e := range expect {
		if problem := evalProblem(e); problem != "" {
			missed = append(missed, problem)
			continue
		}
		var ok bool
		switch e.Kind {
		case evalCalled:
			ok = called(e)
		case evalNotCalled:
			ok = !called(evalExpect{Tool: e.Tool})
		case evalSilent:
			ok = words == ""
		case evalSays:
			ok = strings.Contains(words, e.Contains)
		case evalSaysNot:
			ok = !strings.Contains(words, e.Contains)
		}
		if !ok {
			data, _ := json.Marshal(e)
			missed = append(missed, string(data))
		}
	}
	return missed
}

type evalCase struct {
	managerEval
	file   string
	before []agentcore.AgentMessage
	input  agentcore.AgentMessage
	did    []agentcore.AgentMessage
}

// The cases in dir (*.json), decoded; a case that does not read fails the test.
func evalCases(t *testing.T, dir string) []evalCase {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(files)
	var out []evalCase
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		c := evalCase{file: file}
		if err := json.Unmarshal(data, &c.managerEval); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		decode := func(raw json.RawMessage) agentcore.AgentMessage {
			m, err := vvagent.DecodeMessage(raw)
			if err != nil {
				t.Fatalf("%s: %v: %s", file, err, raw)
			}
			return m
		}
		for _, raw := range c.Before {
			c.before = append(c.before, decode(raw))
		}
		c.input = decode(c.Input)
		for _, raw := range c.Did {
			c.did = append(c.did, decode(raw))
		}
		out = append(out, c)
	}
	return out
}
