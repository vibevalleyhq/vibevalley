//go:build evals

package manager

// On the real model, and so never in the default go test: it needs DEEPSEEK_API_KEY and costs money. Each case is sampled
// VIBEVALLEY_EVAL_N times (5) and passes when all but one of them do.

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	vvagent "vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const evalNoResult = "（评测里没有这个工具的结果）"

func TestManagerEvalsLive(t *testing.T) {
	key := os.Getenv("DEEPSEEK_API_KEY")
	if key == "" {
		t.Skip("DEEPSEEK_API_KEY is not set")
	}
	n := 5
	if s := os.Getenv("VIBEVALLEY_EVAL_N"); s != "" {
		var err error
		if n, err = strconv.Atoi(s); err != nil || n < 1 {
			t.Fatalf("VIBEVALLEY_EVAL_N=%q", s)
		}
	}
	need := max(n-1, 1)
	cases := evalCases(t, filepath.Join("testdata", "evals"))
	if dir := os.Getenv("VIBEVALLEY_EVALS"); dir != "" {
		cases = append(cases, evalCases(t, dir)...)
	}
	var table strings.Builder
	fmt.Fprintf(&table, "\n| case | model | passed | tokens |\n|---|---|---|---|\n")
	for _, c := range cases {
		name := filepath.Base(c.file)
		if len(c.Expect) == 0 {
			t.Logf("%s: no expect yet, skipped", name)
			continue
		}
		model := cmp.Or(os.Getenv("VIBEVALLEY_EVAL_MODEL"), c.Model)
		llm, err := vvagent.Deepseek(model, key)
		if err != nil {
			t.Fatal(err)
		}
		passed, tokens := 0, 0
		for i := range n {
			turn, used := evalReplay(t, c, llm)
			tokens += used
			if missed := evalCheck(c.Expect, turn); len(missed) == 0 {
				passed++
			} else {
				t.Logf("%s, sample %d: missed %s\n%s", name, i+1, strings.Join(missed, "; "), vvagent.Transcript(turn))
			}
		}
		fmt.Fprintf(&table, "| %s | %s | %d/%d | %d |\n", name, model, passed, n, tokens)
		if passed < need {
			t.Errorf("%s: passed %d of %d, needs %d", name, passed, n, need)
		}
	}
	t.Log(table.String())
}

// One sample: the brain as brainOf makes it, with the case's memory and conversation, its tools answering from what the case
// recorded; the messages of the turn the input begins, and the tokens they took.
func evalReplay(t *testing.T, c evalCase, llm vvagent.LLM) ([]agentcore.AgentMessage, int) {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(vvagent.MemoryFile(home), []byte(c.Memory), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	fm := &manager{}
	a := vvagent.NewAgent(ctx, vvagent.AgentOptions{
		Name:         protocol.ManagerAgent,
		Instructions: managerSystemPrompt + managerAgentPrompt,
		Model:        llm.Model, StreamOptions: llm.StreamOptions,
		Home: home, Cwd: home,
		Tools:    fm.tools(),
		NoSkills: true, NoSubagents: true, Schedules: new(false), NoSession: true,
	})
	defer a.Close()
	a.Core.SetTools(evalStubs(a.Core.State().Tools, c.did))
	a.Core.SetMessages(c.before)
	events := a.Subscribe()
	defer events.Close()
	a.Send(c.input)
	var turn []agentcore.AgentMessage
	tokens := 0
	for {
		select {
		case e, ok := <-events.C:
			if !ok {
				t.Fatal("the agent closed")
			}
			switch e.Type {
			case agentcore.EventMessageEnd:
				if managerIsInput(e.Message) {
					continue
				}
				if m, ok := e.Message.(ai.AssistantMessage); ok {
					tokens += m.Usage.TotalTokens
					if m.StopReason == ai.StopError {
						t.Fatalf("the model: %s", m.ErrorMessage)
					}
				}
				turn = append(turn, e.Message)
			case vvagent.EventAgentSettled:
				return turn, tokens
			}
		case <-ctx.Done():
			t.Fatal("the turn took too long")
		}
	}
}

// Every tool answers with what the case recorded for it, in the order it was called; none touches the farm.
func evalStubs(tools []agentcore.AgentTool, did []agentcore.AgentMessage) []agentcore.AgentTool {
	recorded := map[string][]ai.ToolResultMessage{}
	for _, m := range did {
		if r, ok := m.(ai.ToolResultMessage); ok {
			recorded[r.ToolName] = append(recorded[r.ToolName], r)
		}
	}
	var mu sync.Mutex
	out := make([]agentcore.AgentTool, len(tools))
	for i, tool := range tools {
		name := tool.Name
		tool.Execute = func(context.Context, string, json.RawMessage, agentcore.AgentToolUpdateCallback) (agentcore.AgentToolResult, error) {
			mu.Lock()
			defer mu.Unlock()
			queue := recorded[name]
			if len(queue) == 0 {
				return agentcore.TextResult(evalNoResult), nil
			}
			recorded[name] = queue[1:]
			return agentcore.AgentToolResult{Content: queue[0].Content, IsError: queue[0].IsError}, nil
		}
		out[i] = tool
	}
	return out
}
