package runs

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// A step that grows (text still streaming in, a tool that has not returned) is sent again under the same number; sends are batched a little.

const (
	crewKeepSteps = 240
	crewTextMax   = 6000
	AskedMax      = 2000
	// Trajectories are looked back on after the helper has gone, so a tool's input and output keep enough to tell what
	// happened: a whole command or patch, a test run's failures.
	crewInputMax = 4000
	// A tool's output keeps its start and its end: a test run's verdict is at the bottom.
	crewOutputHead = 2000
	crewOutputTail = 4000
	crewPushAfter  = 300 * time.Millisecond
	crewSaveAfter  = 1500 * time.Millisecond
)

func Cut(text string, max int) string {
	if base.Units(text) > max {
		return base.Slice(text, 0, max) + "…"
	}
	return text
}

func crewClipOutput(text string) string {
	n := base.Units(text)
	if n <= crewOutputHead+crewOutputTail+40 {
		return text
	}
	return fmt.Sprintf("%s\n… 省略 %d 个字 …\n%s", base.Slice(text, 0, crewOutputHead), n-crewOutputHead-crewOutputTail, base.Slice(text, -crewOutputTail, n))
}

func crewReadJournal(file string) []protocol.WorkStep {
	body, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var steps []protocol.WorkStep
	if json.Unmarshal(body, &steps) != nil {
		return nil
	}
	return steps
}

func crewCallKey(from base.From, callID string) string { return strings.Join(from, "/") + "|" + callID }

type crewRunOn struct {
	n    int64
	from string
}

// All methods are safe for concurrent use.
type crewJournal struct {
	file string
	push func(protocol.WorkStep)
	keep int
	disk *base.FileWriter

	mu    sync.Mutex
	steps []protocol.WorkStep
	next  int64
	// calls are tool calls not yet returned; started is every call started (a sub-agent's steps go under the call
	// that started it). A tool call is known by its id within its agent, never by the id alone.
	calls, started map[string]int64
	// speaking and thinking are the steps said and thought run on into, with whose they are; any other step clears them.
	speaking, thinking *crewRunOn
	dirty              []int64
	pushing, saving    *time.Timer
	closed             bool
}

func crewOpenJournal(file string, initial []protocol.WorkStep, push func(protocol.WorkStep), keep int) *crewJournal {
	if keep <= 0 {
		keep = crewKeepSteps
	}
	j := &crewJournal{file: file, push: push, keep: keep, disk: base.NewFileWriter(file, 0o644), steps: append([]protocol.WorkStep(nil), initial...),
		calls: map[string]int64{}, started: map[string]int64{}}
	if n := len(j.steps); n > 0 {
		j.next = j.steps[n-1].N + 1
	}
	return j
}

func (j *crewJournal) Steps() []protocol.WorkStep {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]protocol.WorkStep{}, j.steps...)
}

func (j *crewJournal) write() error {
	return j.disk.Write(func() ([]byte, error) {
		j.mu.Lock()
		defer j.mu.Unlock()
		if j.steps == nil {
			return []byte("[]"), nil
		}
		return json.Marshal(j.steps)
	})
}

func (j *crewJournal) flush() {
	j.mu.Lock()
	if j.pushing != nil {
		j.pushing.Stop()
		j.pushing = nil
	}
	var out []protocol.WorkStep
	for _, n := range j.dirty {
		if i := j.indexLocked(n); i >= 0 {
			out = append(out, j.steps[i])
		}
	}
	j.dirty = nil
	j.mu.Unlock()
	for _, step := range out {
		j.push(step)
	}
}

func (j *crewJournal) indexLocked(n int64) int {
	for i := len(j.steps) - 1; i >= 0; i-- {
		if j.steps[i].N == n {
			return i
		}
	}
	return -1
}

func (j *crewJournal) changedLocked(n int64) {
	if j.closed {
		return
	}
	if !containsInt64(j.dirty, n) {
		j.dirty = append(j.dirty, n)
	}
	if j.pushing == nil {
		j.pushing = time.AfterFunc(crewPushAfter, j.flush)
	}
	if j.saving != nil {
		j.saving.Stop()
	}
	j.saving = time.AfterFunc(crewSaveAfter, func() {
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

func (j *crewJournal) underLocked(from base.From) *int64 {
	if len(from) == 0 {
		return nil
	}
	parent, ok := j.started[crewCallKey(from[:len(from)-1], from[len(from)-1])]
	if !ok {
		parent = -1
	}
	return &parent
}

func (j *crewJournal) addLocked(step protocol.WorkStep, from base.From) int64 {
	j.speaking, j.thinking = nil, nil
	n := j.next
	j.next++
	step.N, step.At, step.Under = n, base.NowMs(), j.underLocked(from)
	j.steps = append(j.steps, step)
	if over := len(j.steps) - j.keep; over > 0 {
		j.steps = append([]protocol.WorkStep(nil), j.steps[over:]...)
	}
	j.changedLocked(n)
	return n
}

func (j *crewJournal) patchLocked(n int64, change func(*protocol.WorkStep)) {
	i := j.indexLocked(n)
	if i < 0 {
		return
	}
	change(&j.steps[i])
	j.changedLocked(n)
}

func (j *crewJournal) Asked(text string, from base.From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.WorkStep{Kind: protocol.StepKindAsked, Text: Cut(base.Trim(text), AskedMax), On: crewCommentOn(text)}, from)
}

// The journal reads the mark back to tie the step it was asked to the step it comments on.
var crewCommentMark = regexp.MustCompile(`【评论第 (\d+) 步】`)

const (
	crewCommentAbout  = 300
	crewCommentOutput = 800
	// The client shows what follows it.
	crewCommentSays = "我的评论："
)

func CommentText(step protocol.WorkStep, comment string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "【评论第 %d 步】", step.N)
	switch step.Kind {
	case protocol.StepKindTool:
		b.WriteString("关于你这一步的操作：" + Cut(base.Trim(step.Text), crewCommentAbout))
		if step.Input != nil && base.Trim(*step.Input) != "" {
			b.WriteString("\n输入：" + Cut(base.Trim(*step.Input), crewCommentAbout))
		}
		if step.Ok != nil && !*step.Ok {
			b.WriteString("\n（这一步失败了）")
		}
		if step.Output != nil && base.Trim(*step.Output) != "" {
			out := base.Trim(*step.Output)
			if n := base.Units(out); n > crewCommentOutput {
				out = "…" + base.Slice(out, n-crewCommentOutput, n)
			}
			b.WriteString("\n输出的结尾：" + out)
		}
	case protocol.StepKindSaid:
		b.WriteString("关于你说的这段话：" + Cut(base.Trim(step.Text), crewCommentAbout))
	case protocol.StepKindThought:
		b.WriteString("关于你这段思考：" + Cut(base.Trim(step.Text), crewCommentAbout))
	default:
		b.WriteString("关于这一步：" + Cut(base.Trim(step.Text), crewCommentAbout))
	}
	b.WriteString("\n\n" + crewCommentSays + base.Trim(comment))
	return b.String()
}

func crewCommentOn(text string) *int64 {
	m := crewCommentMark.FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func (j *crewJournal) runOn(kind protocol.StepKind, text string, from base.From) {
	if text == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	who := strings.Join(from, "/")
	on := &j.speaking
	if kind == protocol.StepKindThought {
		on = &j.thinking
	}
	if *on != nil && (*on).from == who && j.indexLocked((*on).n) >= 0 {
		j.patchLocked((*on).n, func(s *protocol.WorkStep) { s.Text = Cut(s.Text+text, crewTextMax) })
		return
	}
	n := j.addLocked(protocol.WorkStep{Kind: kind, Text: Cut(text, crewTextMax)}, from)
	*on = &crewRunOn{n: n, from: who}
}

func (j *crewJournal) Said(text string, from base.From) { j.runOn(protocol.StepKindSaid, text, from) }
func (j *crewJournal) Thought(text string, from base.From) {
	j.runOn(protocol.StepKindThought, text, from)
}

func (j *crewJournal) ToolStarted(callID string, start base.ToolStart, from base.From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	action, tool := start.Action, start.Tool
	step := protocol.WorkStep{Kind: protocol.StepKindTool, Text: start.Text, Action: &action, Tool: &tool}
	if start.Input != "" {
		input := Cut(start.Input, crewInputMax)
		step.Input = &input
	}
	n := j.addLocked(step, from)
	j.calls[crewCallKey(from, callID)] = n
	j.started[crewCallKey(from, callID)] = n
}

func (j *crewJournal) ToolInput(callID, input, text string, from base.From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if n, ok := j.calls[crewCallKey(from, callID)]; ok {
		j.patchLocked(n, func(s *protocol.WorkStep) {
			clipped := Cut(input, crewInputMax)
			s.Input = &clipped
			if text != "" {
				s.Text = text
			}
		})
	}
}

func (j *crewJournal) ToolEnded(callID, output string, ok bool, from base.From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key := crewCallKey(from, callID)
	n, found := j.calls[key]
	if !found {
		return
	}
	delete(j.calls, key)
	j.patchLocked(n, func(s *protocol.WorkStep) {
		s.Ok = &ok
		if base.Trim(output) != "" {
			clipped := crewClipOutput(base.TrimEnd(output))
			s.Output = &clipped
		}
	})
}

func (j *crewJournal) Note(kind protocol.StepKind, text string, from base.From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.WorkStep{Kind: kind, Text: text}, from)
}

func (j *crewJournal) Close() {
	j.flush()
	j.mu.Lock()
	if j.saving != nil {
		j.saving.Stop()
	}
	j.closed = true
	j.mu.Unlock()
	_ = j.write()
}
