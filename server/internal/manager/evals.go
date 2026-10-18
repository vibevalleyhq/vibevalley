package manager

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	vvagent "vibevalley/internal/agent/brain"
	"vibevalley/internal/base"
	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// A case of the manager's evals, as saved in evals/<id>.json under its home. Before, Input and Did are lines of manager.jsonl as
// written there: what the model saw when the turn began (compactions applied), the input that began it, and the messages of the
// turn up to the next input.
type managerEval struct {
	ID      string `json:"id"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Want    string `json:"want"`
	// The whole MEMORY.md when the turn was marked, not necessarily as it was in the turn.
	Memory string            `json:"memory"`
	Tools  []string          `json:"tools"`
	Before []json.RawMessage `json:"before"`
	Input  json.RawMessage   `json:"input"`
	Did    []json.RawMessage `json:"did"`
	// Written by whoever fixes the error; empty when saved.
	Expect []evalExpect `json:"expect"`
}

// One check on a turn, a closed set by Kind: called (Tool, and ArgContains in its arguments' JSON when given), notCalled (Tool),
// silent (no words said), says (Contains in the words), saysNot (Contains not in them). evalCheck in evals_check_test.go
// judges them; a kind added here is added there.
type evalExpect struct {
	Kind        string `json:"kind"`
	Tool        string `json:"tool,omitempty"`
	ArgContains string `json:"argContains,omitempty"`
	Contains    string `json:"contains,omitempty"`
}

func managerEvalsDir(home string) string { return filepath.Join(memory.ManagerHome(home), "evals") }

func managerSessionFile(home string) string {
	return filepath.Join(memory.ManagerHome(home), protocol.ManagerAgent+".jsonl")
}

func (fm *manager) MarkWrong(on int64, want string) (protocol.ManagerEval, error) {
	want = str.Trim(want)
	if want == "" {
		return protocol.ManagerEval{}, errors.New("写一句它应该怎样")
	}
	var asked *protocol.SessionEvent
	for _, e := range fm.trace.Events() {
		if e.Seq == on {
			asked = &e
			break
		}
	}
	if asked == nil {
		return protocol.ManagerEval{}, protocol.Missing{What: fmt.Sprintf("管家轨迹里没有第 %d 步", on)}
	}
	if asked.Type != protocol.SessionEventTypeUserMessage {
		return protocol.ManagerEval{}, fmt.Errorf("第 %d 步不是管家收到的话", on)
	}
	lines := vvagent.ReadLines(managerSessionFile(fm.cfg.Home))
	at := managerTurnAt(lines, *asked)
	if at < 0 {
		return protocol.ManagerEval{}, fmt.Errorf("第 %d 步收到的话没进管家的对话（那时管家没起来？）", on)
	}
	memoryText, _ := os.ReadFile(vvagent.MemoryFile(memory.ManagerHome(fm.cfg.Home)))
	eval := managerEval{
		ID: base.NewID(), Created: clock.NowMs(), Model: fm.modelID(), Want: want, Memory: string(memoryText), Tools: fm.toolNames(),
		Before: managerRawLines(vvagent.Replay(lines[:at])), Input: json.RawMessage(managerRaw(lines[at])),
		Did: managerRawLines(managerTurn(lines[at+1:])), Expect: []evalExpect{},
	}
	file := filepath.Join(managerEvalsDir(fm.cfg.Home), eval.ID+".json")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return protocol.ManagerEval{}, err
	}
	if err := base.NewFileWriter(file, 0o600).Write(func() ([]byte, error) { return managerEvalJSON(eval) }); err != nil {
		return protocol.ManagerEval{}, err
	}
	return protocol.ManagerEval{ID: eval.ID, File: file}, nil
}

// The input that began the turn asked: the run's journal logs the line when the input is taken, after sendInput made the
// message, so the message is no newer than the step, and it holds the step's words (the step is trimmed and may be cut; the
// message puts the time, the farm and the news before them). Of those, the newest: an older one with the same words was taken
// before. -1 when none is.
func managerTurnAt(lines []agentcore.AgentMessage, asked protocol.SessionEvent) int {
	head := strings.TrimSuffix(asked.Text, "…")
	at := -1
	for i, m := range lines {
		if managerIsInput(m) && m.Time() <= asked.Time && strings.Contains(vvagent.MessageText(m), head) && (at < 0 || m.Time() >= lines[at].Time()) {
			at = i
		}
	}
	return at
}

func managerIsInput(m agentcore.AgentMessage) bool {
	custom, ok := m.(vvagent.CustomMessage)
	return ok && custom.CustomType == "managerInput"
}

// What followed an input until the next one, without the compactions written after a run.
func managerTurn(rest []agentcore.AgentMessage) []agentcore.AgentMessage {
	var out []agentcore.AgentMessage
	for _, m := range rest {
		if managerIsInput(m) {
			break
		}
		if _, ok := m.(vvagent.CompactionSummaryMessage); ok {
			continue
		}
		out = append(out, m)
	}
	return out
}

func managerRaw(m agentcore.AgentMessage) string { return ai.Stringify(m) }

func managerRawLines(messages []agentcore.AgentMessage) []json.RawMessage {
	out := make([]json.RawMessage, len(messages))
	for i, m := range messages {
		out[i] = json.RawMessage(managerRaw(m))
	}
	return out
}

// Indented, and without json's HTML escapes: someone reads it and writes its expect by hand.
func managerEvalJSON(eval managerEval) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	err := enc.Encode(eval)
	return b.Bytes(), err
}

func (fm *manager) modelID() string {
	if fm.llm != nil {
		return fm.llm.Model.ID
	}
	if id, err := managerDeepseekModel(fm.modelOf()); err == nil {
		return id
	}
	return fm.modelOf()
}

// The brain's tools: the manager's and internal/agent/brain's own, as brainOf gives them (no skills' folder, no subagents, no schedules).
func (fm *manager) toolNames() []string {
	tools := append(fm.tools(), vvagent.SelfTools(vvagent.SelfOptions{Memory: true})...)
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = t.Name
	}
	return names
}
