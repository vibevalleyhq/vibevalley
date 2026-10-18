package session

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// A step that grows (text still streaming in, a tool that has not returned) is sent again under the same number; sends are batched a little.

const (
	keepEvents = 240
	textMax    = 6000
	AskedMax   = 2000
	// Trajectories are looked back on after the session has gone, so a tool's input and output keep enough to tell what
	// happened: a whole command or patch, a test run's failures.
	inputMax = 4000
	// A tool's output keeps its start and its end: a test run's verdict is at the bottom.
	outputHead       = 2000
	outputTail       = 4000
	pushAfter        = 300 * time.Millisecond
	sessionSaveAfter = 1500 * time.Millisecond
)

func clipOutput(text string) string {
	n := str.Units(text)
	if n <= outputHead+outputTail+40 {
		return text
	}
	return fmt.Sprintf("%s\n… 省略 %d 个字 …\n%s", str.Slice(text, 0, outputHead), n-outputHead-outputTail, str.Slice(text, -outputTail, n))
}

func readJournal(file string) []protocol.SessionEvent {
	body, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var steps []protocol.SessionEvent
	if json.Unmarshal(body, &steps) != nil {
		return nil
	}
	return steps
}

func callKey(from From, callID string) string { return strings.Join(from, "/") + "|" + callID }

// All methods are safe for concurrent use.
type journal struct {
	file string
	push func(protocol.SessionEvent)
	keep int
	disk *base.FileWriter

	mu    sync.Mutex
	steps []protocol.SessionEvent
	next  int64
	// calls are tool calls not yet returned; started is every call started (a sub-agent's steps go under the call
	// that started it). A tool call is known by its id within its agent, never by the id alone.
	calls, started map[string]int64
	// draft is the event still being written: text said or thought as it streams, or a tool call before its input. It has
	// its seq and is pushed live, but is not in steps (nor on disk) until it is sealed, before any other event is added.
	draft    *protocol.SessionEvent
	draftWho string
	// draftCall is the draft's call key when the draft is a tool call.
	draftCall       string
	dirty           []int64
	pushing, saving *time.Timer
	closed          bool
	// run is the open run the events belong to, nil between runs.
	run *string
}

func openJournal(file string, initial []protocol.SessionEvent, push func(protocol.SessionEvent), keep int) *journal {
	if keep <= 0 {
		keep = keepEvents
	}
	j := &journal{file: file, push: push, keep: keep, disk: base.NewFileWriter(file, 0o644), steps: append([]protocol.SessionEvent(nil), initial...),
		calls: map[string]int64{}, started: map[string]int64{}}
	if n := len(j.steps); n > 0 {
		j.next = j.steps[n-1].Seq + 1
	}
	return j
}

// Events are the written ones and, last, the draft as it is now.
func (j *journal) Events() []protocol.SessionEvent {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := append([]protocol.SessionEvent{}, j.steps...)
	if j.draft != nil {
		out = append(out, *j.draft)
	}
	return out
}

func (j *journal) body() ([]byte, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.steps == nil {
		return []byte("[]"), nil
	}
	return json.Marshal(j.steps)
}

func (j *journal) write() error { return j.disk.Write(j.body) }

func (j *journal) flush() {
	j.mu.Lock()
	if j.pushing != nil {
		j.pushing.Stop()
		j.pushing = nil
	}
	var out []protocol.SessionEvent
	for _, n := range j.dirty {
		if i := j.indexLocked(n); i >= 0 {
			out = append(out, j.steps[i])
		} else if j.draft != nil && j.draft.Seq == n {
			out = append(out, *j.draft)
		}
	}
	j.dirty = nil
	j.mu.Unlock()
	for _, step := range out {
		j.push(step)
	}
}

func (j *journal) indexLocked(n int64) int {
	for i := len(j.steps) - 1; i >= 0; i-- {
		if j.steps[i].Seq == n {
			return i
		}
	}
	return -1
}

func (j *journal) changedLocked(n int64) {
	if j.closed {
		return
	}
	if !containsInt64(j.dirty, n) {
		j.dirty = append(j.dirty, n)
	}
	if j.pushing == nil {
		j.pushing = time.AfterFunc(pushAfter, j.flush)
	}
	if j.saving != nil {
		j.saving.Stop()
	}
	j.saving = time.AfterFunc(sessionSaveAfter, func() {
		if err := j.write(); err != nil {
			log.Printf("vibevalley: could not save %s: %v", j.file, err)
		}
	})
}

func containsInt64(list []int64, n int64) bool {
	for _, x := range list {
		if x == n {
			return true
		}
	}
	return false
}

func (j *journal) underLocked(from From) *int64 {
	if len(from) == 0 {
		return nil
	}
	parent, ok := j.started[callKey(from[:len(from)-1], from[len(from)-1])]
	if !ok {
		parent = -1
	}
	return &parent
}

// stampLocked gives an event the next seq, the time, the call it is under and the open run.
func (j *journal) stampLocked(step *protocol.SessionEvent, from From) {
	step.Seq, step.Time, step.Under, step.Run = j.next, clock.NowMs(), j.underLocked(from), j.run
	j.next++
}

// sealLocked writes the draft, as it is, after every event before it.
func (j *journal) sealLocked() {
	if j.draft == nil {
		return
	}
	d := *j.draft
	j.draft, j.draftWho, j.draftCall = nil, "", ""
	j.appendLocked(d)
}

func (j *journal) addLocked(step protocol.SessionEvent, from From) int64 {
	j.sealLocked()
	j.stampLocked(&step, from)
	j.appendLocked(step)
	return step.Seq
}

func (j *journal) appendLocked(step protocol.SessionEvent) {
	j.steps = append(j.steps, step)
	if over := len(j.steps) - j.keep; over > 0 {
		j.steps = append([]protocol.SessionEvent(nil), j.steps[over:]...)
	}
	j.changedLocked(step.Seq)
}

// draftLocked makes e the draft, sealing the one before; it is pushed live from now on.
func (j *journal) draftLocked(e protocol.SessionEvent, from From, call string) {
	j.sealLocked()
	j.stampLocked(&e, from)
	j.draft, j.draftWho, j.draftCall = &e, strings.Join(from, "/"), call
	j.changedLocked(e.Seq)
}

func (j *journal) RunStarted(id string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.run = &id
	j.addLocked(protocol.SessionEvent{Type: protocol.SessionEventTypeRunStart}, nil)
}

func (j *journal) RunEnded(id string, outcome protocol.Outcome) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.run == nil || *j.run != id {
		return
	}
	j.addLocked(protocol.SessionEvent{Type: protocol.SessionEventTypeRunEnd, Text: string(outcome)}, nil)
	j.run = nil
}

func (j *journal) Asked(text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.SessionEvent{Type: protocol.SessionEventTypeUserMessage, Text: str.Cut(str.Trim(text), AskedMax)}, from)
}

// runOn goes on with what is being said or thought, by the same one, in the draft; anything else starts a new one.
func (j *journal) runOn(kind protocol.SessionEventType, text string, from From) {
	if text == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if d := j.draft; d != nil && d.Type == kind && j.draftWho == strings.Join(from, "/") {
		d.Text = str.Cut(d.Text+text, textMax)
		j.changedLocked(d.Seq)
		return
	}
	j.draftLocked(protocol.SessionEvent{Type: kind, Text: str.Cut(text, textMax)}, from, "")
}

func (j *journal) Said(text string, from From) {
	j.runOn(protocol.SessionEventTypeAssistantMessage, text, from)
}
func (j *journal) Thought(text string, from From) {
	j.runOn(protocol.SessionEventTypeAssistantThinking, text, from)
}

func (j *journal) ToolStarted(callID string, start ToolStart, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	action, tool := start.Action, start.Tool
	step := protocol.SessionEvent{Type: protocol.SessionEventTypeToolCall, Text: start.Text, Action: &action, Tool: &tool}
	if start.Input != "" {
		input := str.Cut(start.Input, inputMax)
		step.Input = &input
	}
	key := callKey(from, callID)
	// Written once its input is known; one that came with it is.
	if step.Input != nil {
		n := j.addLocked(step, from)
		j.calls[key], j.started[key] = n, n
		return
	}
	j.draftLocked(step, from, key)
	j.calls[key], j.started[key] = j.draft.Seq, j.draft.Seq
}

func (j *journal) ToolInput(callID, input, text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	// Only the draft takes it: a call already written is not changed (its input came too late to be in it).
	if d := j.draft; d != nil && j.draftCall == callKey(from, callID) {
		clipped := str.Cut(input, inputMax)
		d.Input = &clipped
		if text != "" {
			d.Text = text
		}
		j.sealLocked()
	}
}

func (j *journal) ToolEnded(callID, output string, ok bool, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key := callKey(from, callID)
	n, found := j.calls[key]
	if !found {
		return
	}
	delete(j.calls, key)
	result := protocol.SessionEvent{Type: protocol.SessionEventTypeToolResult, Call: &n, Ok: &ok}
	if str.Trim(output) != "" {
		clipped := clipOutput(str.TrimEnd(output))
		result.Output = &clipped
	}
	j.addLocked(result, from)
}

func (j *journal) Note(kind protocol.SessionEventType, text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.SessionEvent{Type: kind, Text: text}, from)
}

func (j *journal) Usage(tokens protocol.EventTokens, text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.SessionEvent{Type: protocol.SessionEventTypeLLMUsage, Text: text, Tokens: &tokens}, from)
}

func (j *journal) Close() {
	j.mu.Lock()
	j.sealLocked()
	j.mu.Unlock()
	j.flush()
	j.mu.Lock()
	if j.saving != nil {
		j.saving.Stop()
	}
	j.closed = true
	j.mu.Unlock()
	if err := j.disk.Finish(j.body); err != nil {
		log.Printf("vibevalley: could not save %s: %v", j.file, err)
	}
}
