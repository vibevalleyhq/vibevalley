package oarruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"

	"vibevalley/internal/agent/brain"
	"vibevalley/pkg/ai"
)

func temp(t *testing.T, name string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vibevalley-runtime-"+name+"-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func lastUser(c ai.Context) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if m, ok := c.Messages[i].(ai.UserMessage); ok {
			return m.Content.Words("")
		}
	}
	return ""
}

type rig struct {
	t       *testing.T
	session oar.Session
	faux    *ai.FauxProviderHandle
	cwd     string
	home    string
	mu      sync.Mutex
	events  []oar.Event
}

func (r *rig) all() []oar.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]oar.Event(nil), r.events...)
}

type openOptions struct {
	resume string
	home   string
	cwd    string
	faux   *ai.FauxProviderHandle
	mcp    string
	append string
}

func open(t *testing.T, steps []ai.FauxResponseStep, extra openOptions) *rig {
	t.Helper()
	faux := extra.faux
	if faux == nil {
		faux = ai.FauxProvider(ai.FauxProviderOptions{Delay: 2 * time.Millisecond})
	}
	faux.AppendResponses(steps...)
	home := extra.home
	if home == "" {
		home = temp(t, "home")
	}
	cwd := extra.cwd
	if cwd == "" {
		cwd = temp(t, "work")
	}
	runtime := VibeValleyRuntime(Options{
		Home:      func() string { return home },
		Llm:       func(context.Context, string) (brain.LLM, error) { return brain.LLM{Model: faux.GetModel()}, nil },
		Providers: []ai.ApiProvider{faux.Provider},
	})
	options := oar.SessionOptions{Cwd: cwd, Resume: extra.resume}
	if extra.append != "" {
		options.AppendSystemPrompt = oar.String(extra.append)
	}
	if extra.mcp != "" {
		node, _ := exec.LookPath("node")
		options.MCPServers = []oar.McpServer{{Name: "farm", Command: node, Args: []string{extra.mcp}}}
	}
	session, err := runtime.Session(context.Background(), oar.AvailableInstallation{Via: "bundled"}, options)
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{t: t, session: session, faux: faux, cwd: cwd, home: home}
	session.Events(func(e oar.Event) {
		r.mu.Lock()
		r.events = append(r.events, e)
		r.mu.Unlock()
	}, oar.EventsOptions{Cursor: &oar.Cursor{SessionID: session.ID(), AfterSeq: -1}})
	return r
}

func ended(events []oar.Event) []oar.TurnEnded {
	var out []oar.TurnEnded
	for _, e := range events {
		if body, ok := e.Body.(oar.TurnEnded); ok {
			out = append(out, body)
		}
	}
	return out
}

func (r *rig) untilTurns(n int) {
	r.t.Helper()
	for i := 0; i < 500 && len(ended(r.all())) < n; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if got := len(ended(r.all())); got != n {
		r.t.Fatalf("expected %d turns to end, %d did", n, got)
	}
}

func (r *rig) until(f func(oar.Event) bool) {
	r.t.Helper()
	for i := 0; i < 500; i++ {
		for _, e := range r.all() {
			if f(e) {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	r.t.Fatal("timed out waiting for an event")
}

func (r *rig) text() string {
	var b strings.Builder
	for _, e := range r.all() {
		if d, ok := e.Body.(oar.TextDelta); ok {
			b.WriteString(d.Text)
		}
	}
	return b.String()
}

func toolStarted(e oar.Event) bool { _, ok := e.Body.(oar.ToolCallStarted); return ok }

func eq(t *testing.T, got, want any) {
	t.Helper()
	if fmt.Sprintf("%#v", got) != fmt.Sprintf("%#v", want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

func accepted(t *testing.T, o oar.ControlOutcome, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if !o.IsAccepted() {
		t.Fatalf("rejected: %s %s", o.Code, o.Reason)
	}
}

func TestAPromptRunsToolsAndEndsCompleted(t *testing.T) {
	r := open(t, []ai.FauxResponseStep{
		ai.FauxAssistantMessage([]ai.Content{ai.FauxText("我来写"), ai.FauxToolCall("write_file", `{"path":"hello.txt","content":"hi"}`, "")}),
		ai.FauxAssistantMessage("写好了 hello.txt"),
	}, openOptions{append: "你是后端老周。"})
	defer r.session.Dispose(context.Background())
	o, err := r.session.Prompt(context.Background(), "写个 hello.txt", oar.InputOptions{})
	accepted(t, o, err)
	r.untilTurns(1)
	data, _ := os.ReadFile(filepath.Join(r.cwd, "hello.txt"))
	eq(t, string(data), "hi")
	kinds := map[string]bool{}
	for _, e := range r.all() {
		kinds[e.Kind()] = true
	}
	for _, k := range []string{"model", "text_delta", "tool_call_started", "tool_call_ended", "turn_ended", "usage"} {
		if !kinds[k] {
			t.Fatalf("no %s", k)
		}
	}
	for _, e := range r.all() {
		if s, ok := e.Body.(oar.ToolCallStarted); ok {
			eq(t, s.Tool, "write_file")
			eq(t, *s.Input, `{"path":"hello.txt","content":"hi"}`)
		}
		if s, ok := e.Body.(oar.ToolCallEnded); ok {
			eq(t, s.Result, "ok")
		}
	}
	eq(t, ended(r.all())[0].Outcome.Kind, "completed")
	eq(t, r.text(), "我来写写好了 hello.txt")
	prompt := r.faux.State().Contexts[0].SystemPrompt
	if !strings.HasPrefix(prompt, HELPER_INSTRUCTIONS) || !strings.Contains(prompt, "你是后端老周。") {
		t.Fatal(prompt)
	}
}

func TestSteerJoinsQueuedWaitsOrIsWithdrawn(t *testing.T) {
	nap := ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("bash", `{"command":"sleep 0.2"}`, "")})
	r := open(t, []ai.FauxResponseStep{
		nap,
		ai.FauxResponseFactory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("听到：" + lastUser(c))
		}),
		ai.FauxResponseFactory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("排到了：" + lastUser(c))
		}),
	}, openOptions{})
	defer r.session.Dispose(context.Background())
	ctx := context.Background()
	_, _ = r.session.Prompt(ctx, "开始", oar.InputOptions{})
	r.until(toolStarted)
	busy, _ := r.session.Prompt(ctx, "又一个", oar.InputOptions{})
	eq(t, busy.IsAccepted(), false)
	o, err := r.session.Steer(ctx, "顺便", oar.InputOptions{})
	accepted(t, o, err)
	_, _ = r.session.Queue(ctx, "然后", oar.InputOptions{})
	dropped, _ := r.session.Queue(ctx, "不要了", oar.InputOptions{})
	o, err = r.session.Withdraw(ctx, dropped.Request.Request.InputID)
	accepted(t, o, err)
	r.untilTurns(2)
	eq(t, r.text(), "听到：顺便排到了：然后")
	eq(t, r.faux.GetPendingResponseCount(), 0)
}

func TestAbortEndsTheTurnAborted(t *testing.T) {
	r := open(t, []ai.FauxResponseStep{ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("bash", `{"command":"sleep 5"}`, "")})}, openOptions{})
	defer r.session.Dispose(context.Background())
	ctx := context.Background()
	_, _ = r.session.Prompt(ctx, "睡", oar.InputOptions{})
	r.until(toolStarted)
	o, err := r.session.Abort(ctx)
	accepted(t, o, err)
	r.untilTurns(1)
	eq(t, ended(r.all())[0].Outcome.Kind, "aborted")
	again, _ := r.session.Abort(ctx)
	eq(t, again.IsAccepted(), false)
}

func TestAResumedSessionGoesOn(t *testing.T) {
	count := ai.FauxResponseFactory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		n := 0
		for _, m := range c.Messages {
			if m.Role() == "user" {
				n++
			}
		}
		return ai.FauxAssistantMessage(fmt.Sprintf("第 %d 句", n))
	})
	first := open(t, []ai.FauxResponseStep{count}, openOptions{})
	_, _ = first.session.Prompt(context.Background(), "一", oar.InputOptions{})
	first.untilTurns(1)
	_ = first.session.Dispose(context.Background())
	again := open(t, []ai.FauxResponseStep{count}, openOptions{resume: first.session.ID(), home: first.home, cwd: first.cwd})
	defer again.session.Dispose(context.Background())
	eq(t, again.session.ID(), first.session.ID())
	_, _ = again.session.Prompt(context.Background(), "二", oar.InputOptions{})
	again.untilTurns(1)
	eq(t, again.text(), "第 2 句")
}

const fakeMCP = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'farm', version: '1' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'say', description: '在田头说话', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '说了：' + m.params.arguments.text }] } })
})
`

func TestTheSessionsMCPServersToolsReachTheModel(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node on PATH")
	}
	dir := temp(t, "mcp")
	_ = os.WriteFile(filepath.Join(dir, "farm.cjs"), []byte(fakeMCP), 0o644)
	r := open(t, []ai.FauxResponseStep{
		ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("farm__say", `{"text":"做完了"}`, "")}),
		ai.FauxResponseFactory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			if c.Messages[len(c.Messages)-1].Role() == "toolResult" {
				return ai.FauxAssistantMessage("好")
			}
			return ai.FauxAssistantMessage("没调到")
		}),
	}, openOptions{mcp: filepath.Join(dir, "farm.cjs")})
	defer r.session.Dispose(context.Background())
	_, _ = r.session.Prompt(context.Background(), "汇报", oar.InputOptions{})
	r.untilTurns(1)
	found := false
	for _, tool := range r.faux.State().Contexts[0].Tools {
		if tool.Name == "farm__say" {
			found = true
		}
	}
	eq(t, found, true)
	for _, e := range r.all() {
		if end, ok := e.Body.(oar.ToolCallEnded); ok {
			eq(t, end.Content[0].Text, "说了：做完了")
		}
	}
}

func TestAModelThatFailsFailsTheTurn(t *testing.T) {
	r := open(t, []ai.FauxResponseStep{ai.FauxAssistantMessage("", ai.FauxOptions{StopReason: ai.StopError, ErrorMessage: "DeepSeek 回了 503"})}, openOptions{})
	defer r.session.Dispose(context.Background())
	_, _ = r.session.Prompt(context.Background(), "试试", oar.InputOptions{})
	r.untilTurns(1)
	outcome := ended(r.all())[0].Outcome
	eq(t, outcome.Kind, "failed")
	eq(t, outcome.Reason, "DeepSeek 回了 503")
}

func TestTheRuntimeListsDeepSeeksModels(t *testing.T) {
	faux := ai.FauxProvider(ai.FauxProviderOptions{})
	runtime := VibeValleyRuntime(Options{Llm: func(context.Context, string) (brain.LLM, error) { return brain.LLM{Model: faux.GetModel()}, nil }})
	models, _ := runtime.ListModels(context.Background(), oar.AvailableInstallation{Via: "bundled"}, oar.ListModelsOptions{})
	found := false
	for _, m := range models.Models {
		if m.ID == "deepseek-flash" && strings.Join(m.EffortLevels, ",") == "high,max" && m.Default {
			found = true
		}
	}
	eq(t, models.Kind == "ok" && found, true)
	installation, _ := runtime.Installation(context.Background(), oar.InstallationOptions{})
	eq(t, installation.Kind, "available")
	eq(t, installation.Available.Via, "bundled")
	_, err := runtime.Session(context.Background(), oar.AvailableInstallation{Via: "bundled"}, oar.SessionOptions{Cwd: os.TempDir(), Effort: "low"})
	if err == nil || !regexp.MustCompile(`只有 high、max`).MatchString(err.Error()) {
		t.Fatal(err)
	}
	keyless := VibeValleyRuntime(Options{Llm: func(context.Context, string) (brain.LLM, error) {
		return brain.LLM{}, errors.New("没有 DeepSeek 的密钥")
	}})
	snapshot, _ := keyless.Installation(context.Background(), oar.InstallationOptions{})
	eq(t, snapshot.Kind, "unsupported")
	eq(t, snapshot.Reason, "没有 DeepSeek 的密钥")
}
