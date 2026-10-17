package session

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
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// A step that grows (text still streaming in, a tool that has not returned) is sent again under the same number; sends are batched a little.

const (
	keepActivities = 240
	textMax        = 6000
	AskedMax       = 2000
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

func readJournal(file string) []protocol.Activity {
	body, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var steps []protocol.Activity
	if json.Unmarshal(body, &steps) != nil {
		return nil
	}
	return steps
}

func callKey(from From, callID string) string { return strings.Join(from, "/") + "|" + callID }

type runOn struct {
	n    int64
	from string
}

// All methods are safe for concurrent use.
type journal struct {
	file string
	push func(protocol.Activity)
	keep int
	disk *base.FileWriter

	mu    sync.Mutex
	steps []protocol.Activity
	next  int64
	// calls are tool calls not yet returned; started is every call started (a sub-agent's steps go under the call
	// that started it). A tool call is known by its id within its agent, never by the id alone.
	calls, started map[string]int64
	// speaking and thinking are the steps said and thought run on into, with whose they are; any other step clears them.
	speaking, thinking *runOn
	dirty              []int64
	pushing, saving    *time.Timer
	closed             bool
}

func openJournal(file string, initial []protocol.Activity, push func(protocol.Activity), keep int) *journal {
	if keep <= 0 {
		keep = keepActivities
	}
	j := &journal{file: file, push: push, keep: keep, disk: base.NewFileWriter(file, 0o644), steps: append([]protocol.Activity(nil), initial...),
		calls: map[string]int64{}, started: map[string]int64{}}
	if n := len(j.steps); n > 0 {
		j.next = j.steps[n-1].N + 1
	}
	return j
}

func (j *journal) Activities() []protocol.Activity {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]protocol.Activity{}, j.steps...)
}

func (j *journal) write() error {
	return j.disk.Write(func() ([]byte, error) {
		j.mu.Lock()
		defer j.mu.Unlock()
		if j.steps == nil {
			return []byte("[]"), nil
		}
		return json.Marshal(j.steps)
	})
}

func (j *journal) flush() {
	j.mu.Lock()
	if j.pushing != nil {
		j.pushing.Stop()
		j.pushing = nil
	}
	var out []protocol.Activity
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

func (j *journal) indexLocked(n int64) int {
	for i := len(j.steps) - 1; i >= 0; i-- {
		if j.steps[i].N == n {
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

func (j *journal) addLocked(step protocol.Activity, from From) int64 {
	j.speaking, j.thinking = nil, nil
	n := j.next
	j.next++
	step.N, step.At, step.Under = n, clock.NowMs(), j.underLocked(from)
	j.steps = append(j.steps, step)
	if over := len(j.steps) - j.keep; over > 0 {
		j.steps = append([]protocol.Activity(nil), j.steps[over:]...)
	}
	j.changedLocked(n)
	return n
}

func (j *journal) patchLocked(n int64, change func(*protocol.Activity)) {
	i := j.indexLocked(n)
	if i < 0 {
		return
	}
	change(&j.steps[i])
	j.changedLocked(n)
}

func (j *journal) Asked(text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.Activity{Kind: protocol.ActivityKindPrompt, Text: str.Cut(str.Trim(text), AskedMax), On: commentOn(text)}, from)
}

// The journal reads the mark back to tie the step it was asked to the step it comments on.
var commentMark = regexp.MustCompile(`【评论第 (\d+) 步】`)

const (
	commentAbout  = 300
	commentOutput = 800
	// The client shows what follows it.
	commentSays = "我的评论："
)

func CommentText(step protocol.Activity, comment string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "【评论第 %d 步】", step.N)
	switch step.Kind {
	case protocol.ActivityKindAction:
		b.WriteString("关于你这一步的操作：" + str.Cut(str.Trim(step.Text), commentAbout))
		if step.Input != nil && str.Trim(*step.Input) != "" {
			b.WriteString("\n输入：" + str.Cut(str.Trim(*step.Input), commentAbout))
		}
		if step.Ok != nil && !*step.Ok {
			b.WriteString("\n（这一步失败了）")
		}
		if step.Output != nil && str.Trim(*step.Output) != "" {
			out := str.Trim(*step.Output)
			if n := str.Units(out); n > commentOutput {
				out = "…" + str.Slice(out, n-commentOutput, n)
			}
			b.WriteString("\n输出的结尾：" + out)
		}
	case protocol.ActivityKindResponse:
		b.WriteString("关于你说的这段话：" + str.Cut(str.Trim(step.Text), commentAbout))
	case protocol.ActivityKindThought:
		b.WriteString("关于你这段思考：" + str.Cut(str.Trim(step.Text), commentAbout))
	default:
		b.WriteString("关于这一步：" + str.Cut(str.Trim(step.Text), commentAbout))
	}
	b.WriteString("\n\n" + commentSays + str.Trim(comment))
	return b.String()
}

func commentOn(text string) *int64 {
	m := commentMark.FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func (j *journal) runOn(kind protocol.ActivityKind, text string, from From) {
	if text == "" {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	who := strings.Join(from, "/")
	on := &j.speaking
	if kind == protocol.ActivityKindThought {
		on = &j.thinking
	}
	if *on != nil && (*on).from == who && j.indexLocked((*on).n) >= 0 {
		j.patchLocked((*on).n, func(s *protocol.Activity) { s.Text = str.Cut(s.Text+text, textMax) })
		return
	}
	n := j.addLocked(protocol.Activity{Kind: kind, Text: str.Cut(text, textMax)}, from)
	*on = &runOn{n: n, from: who}
}

func (j *journal) Said(text string, from From) { j.runOn(protocol.ActivityKindResponse, text, from) }
func (j *journal) Thought(text string, from From) {
	j.runOn(protocol.ActivityKindThought, text, from)
}

func (j *journal) ToolStarted(callID string, start ToolStart, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	action, tool := start.Action, start.Tool
	step := protocol.Activity{Kind: protocol.ActivityKindAction, Text: start.Text, Action: &action, Tool: &tool}
	if start.Input != "" {
		input := str.Cut(start.Input, inputMax)
		step.Input = &input
	}
	n := j.addLocked(step, from)
	j.calls[callKey(from, callID)] = n
	j.started[callKey(from, callID)] = n
}

func (j *journal) ToolInput(callID, input, text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if n, ok := j.calls[callKey(from, callID)]; ok {
		j.patchLocked(n, func(s *protocol.Activity) {
			clipped := str.Cut(input, inputMax)
			s.Input = &clipped
			if text != "" {
				s.Text = text
			}
		})
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
	j.patchLocked(n, func(s *protocol.Activity) {
		s.Ok = &ok
		if str.Trim(output) != "" {
			clipped := clipOutput(str.TrimEnd(output))
			s.Output = &clipped
		}
	})
}

func (j *journal) Note(kind protocol.ActivityKind, text string, from From) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.addLocked(protocol.Activity{Kind: kind, Text: text}, from)
}

func (j *journal) Close() {
	j.flush()
	j.mu.Lock()
	if j.saving != nil {
		j.saving.Stop()
	}
	j.closed = true
	j.mu.Unlock()
	if err := j.write(); err != nil {
		log.Printf("vibevalley: could not save %s: %v", j.file, err)
	}
}
