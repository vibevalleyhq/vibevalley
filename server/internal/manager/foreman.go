package manager

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/fx"

	"vibevalley/internal/base"
	"vibevalley/internal/chat"
	"vibevalley/internal/memory"
	"vibevalley/internal/projects"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
	"vibevalley/internal/tickets"
	"vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

// The manager (管家; ported from the TypeScript server's foreman.ts, foreman-agent.ts, removed). Typed lines and lines heard by voice reach it;
// it hires and talks to helpers through the crew, and its words stream onto the farm as the manager's messages. What
// it thinks with is vibevalley's own agent (vibevalley/agent) on DeepSeek ($VIBEVALLEY_FOREMAN_MODEL, else deepseek-flash), with
// the manager's tools and no others (it does not code: no files, commands, skills or helpers of its own), and a
// memory it keeps. The farm's situation is in the system prompt of every request, never in the conversation; what
// reached it without waking it goes in as hidden `farmNews` messages, kept. Its folder is $VIBEVALLEY_HOME/foreman.
//
// A person's words join the manager's run under way (Send); schedules, playbook notices, the heartbeat's findings and
// helpers' reports wait until it is free (Later). A schedule that names a helper sends it off without asking the
// manager. The manager on pi (VIBEVALLEY_FOREMAN_RUNTIME=pi, foreman-pi.ts) is not in the Go server: it refuses, saying so.

const (
	// foremanSteps: steps the manager's trajectory keeps, more than a helper's, being the one that stays.
	foremanSteps = 1000
	// foremanStreamEvery: how often a reply still being written is pushed to the page.
	foremanStreamEvery = 120 * time.Millisecond
)

// foremanVoiceNote is what the manager is told of a line said on a call it answers: its words are read out as they come.
const foremanVoiceNote = "（这句话是主人在电话里说的，你的回答会念给主人听：口语，一两句，先说结论；不念代码、路径、命令和长列表。要用工具时可以先说一句「我看一下」。）"

const foremanSystemPrompt = `你是码农场物语的管家。主人跟你说要做的活，你派农场里的帮工去做。帮工是真实的编码 agent（Claude Code、Codex、pi 等），在主人电脑上的目录里改代码、跑命令。你自己不写代码、不读文件，只派活、盯进度、转告结果。

怎么做：
- 主人要做一件事：用 dispatch 派活。工单要写清楚目标、做到什么程度算完。互不相关的几件事可以派给几个帮工。
- 每件活都在一个项目里做：项目就是工作目录下的一个文件夹（「农场现状」里列着）。主人说的项目没有，就新建：起一个简短的英文名（比如 clock-in），dispatch 时填上它，农场会建好文件夹和 git 仓库。拿不准是哪个项目就先问主人。
- 帮工在项目里各自的分支上干活，做完会提交。主人说「收下」「合进去」，或者你确认活做好了、主人也满意，就用 harvest 把它的分支合进项目，帮工随后收工。只想打发走、不要它的改动，用 dismiss（分支会留着）。主人问改了什么，用 changes。
- 收获时会冲突：照结果告诉主人哪些文件冲突；主人同意就用 tell 把结果里那段话转给帮工，让它在自己的分支上解决，做完再收。
- 派不出去说「满了」（地里、这个 runtime 或这个项目同时干活的人数到了上限）：告诉主人，等有人干完再派，或者问主人要不要先收掉谁。
- 挑谁：主人点了帮工的名字就派给他；点了 runtime（比如「让 codex……」）就派给用这个 runtime 的帮工；主人在对话框里选定了帮工，就优先派给他；都没有就按每个帮工「适合的活」挑。挑不准时可以不填 agent，农场会按规则挑。
- 问进度：先看每条消息开头的「农场现状」，要细节再用 check。
- 给帮工带话、叫停这一轮、让他收工：用 tell、stop、dismiss。tell 会把话发在那个帮工的工单串里，它会收到。
- 频道是安排活的地方：「田头」是默认的频道，主人还可以开别的（#clock-in 这样），各有说明和默认项目。你在哪个频道被叫，就在哪个频道回话、派活（dispatch 不填 project 时用频道的默认项目）；主人要开新频道就用 open_channel，看有哪些用 channels。
- 对话在频道里（田头就是一个频道）：主人、你和帮工都在里面说话。每件活有自己的工单串，帮工在串里自己汇报、自己提问，主人看得到，你不用转述。主人在某个串里 @管家 问你，你的回答就发在那个串里。要看一个串里说过什么，用 read_chat。写 @ 就是叫醒那个人（帮工每被叫醒一次都花钱）；只是提到谁、转述谁说了什么，写名字或编号，不带 @。
- 帮工失败了会叫醒你：用一两句话说卡在哪，问主人下一步。其余的汇报会附在「农场现状」后面，需要时再提。
- 额度：「农场现状」里写着每个帮工的 runtime 还剩多少、今天花了多少。剩得不多（标着「快用完了」）的，能换别的帮工就换，并告诉主人；都快用完了就先问主人。余额或每日预算用完了派不出去，照直告诉主人，等主人处理。
- 帮工标着「没动静」：告诉主人它多久没动静、最后在做什么，问要不要叫停。
- 派不出去（没装、停用、满了）：照工具给的原因直说。
- 很长的活（要改好几处、要几个人分工、一轮做不完）：用 plan 起一个种植计划。农场派一个帮工读代码，把它拆成几步，每步一个帮工，有先后；拆好了放在「计划」里等主人看。主人同意了才用 plan_action start 开工；主人想改某一步，用 plan_edit。
- 计划开工以后由农场自己调度：前面的步骤合进计划分支，后面的才开工。计划里的帮工不要用 dispatch、harvest、dismiss 去管。有步骤没做成，问主人是重试（node_action retry）、改工单，还是跳过（node_action skip）。
- 计划都做完了（等收获）：主人说收，就用 plan_action harvest 把整个计划合进主分支。
- 收到「【种植计划】」开头的消息：照里面说的，用一两句话告诉主人。
- 收到「【巡查】」开头的消息：那是农场自己看出来放着没人管的事。值得提醒就在那个频道里用一两句话提醒主人（问题没人回、活做完了没收、步骤没做成），帮工没动静就看看要不要叫停；不值得就什么也别说。
- 定时：主人说「每天」「每周几」「到点」「过一会儿」「每隔多久」，用 schedule 定在一个频道里（不填就是你正在回话的频道）。到点时频道里先出现一条「⏰ 定时……」，然后你会收到「【定时任务……】」开头的那句话，照着做（派活、看进度、提醒主人），做完说一两句。写了 agent 的定时到点直接派活，不经过你。看有哪些用 list_schedules，不要了用 cancel_schedule。

说话：中文，口语，简短，一般一两句。需要列点时可以用 Markdown，但不要贴大段代码。只说工具结果和汇报里有的东西，不要编造进度、文件名或结果。`

// foremanAgentPrompt is what only vibevalley's own agent can do: it keeps a memory.
const foremanAgentPrompt = `
记性：
- 主人说「记住」「以后都」，或者告诉你一个以后还用得上的偏好、约定：用 remember 记一句。记下的每次都在你的系统提示里。`

// foremanCaller is a call's turn in progress (Call): its words go out as they grow, until the turn settles.
type foremanCaller struct {
	mu     sync.Mutex
	queue  []string
	ended  bool
	signal chan struct{}
}

func (c *foremanCaller) push(text string) {
	c.mu.Lock()
	if !c.ended {
		c.queue = append(c.queue, text)
	}
	c.mu.Unlock()
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

func (c *foremanCaller) end() {
	c.mu.Lock()
	c.ended = true
	c.mu.Unlock()
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

// pump hands the words on in order and closes out once the turn ended and all were handed, or when ctx ends.
func (c *foremanCaller) pump(ctx context.Context, out chan<- string) {
	defer close(out)
	for {
		c.mu.Lock()
		if len(c.queue) > 0 {
			next := c.queue[0]
			c.queue = c.queue[1:]
			c.mu.Unlock()
			select {
			case out <- next:
			case <-ctx.Done():
				return
			}
			continue
		}
		ended := c.ended
		c.mu.Unlock()
		if ended {
			return
		}
		select {
		case <-c.signal:
		case <-ctx.Done():
			return
		}
	}
}

type Foreman struct {
	cfg          base.Config
	site         *base.Site
	store        *base.Store
	settings     *base.Settings
	runtimes     *runs.Runtimes
	trajectories *runs.Trajectories
	projects     *projects.Projects
	crew         *runs.Crew
	dispatch     *tickets.Dispatch
	merges       *tickets.Merges
	chat         *chat.Chat
	playbooks    *tickets.Playbooks
	schedules    *tickets.Schedules
	heartbeat    *tickets.Heartbeat
	// runtime and model: $VIBEVALLEY_FOREMAN_RUNTIME (vibevalley or pi) and $VIBEVALLEY_FOREMAN_MODEL.
	runtime protocol.Runtime
	model   string
	ctx     context.Context

	// Stand-ins for tests: llm is the model to talk to (TS's ForemanLlm; nil: DeepSeek's); trace the manager's
	// trajectory (opened at start when nil).
	llm   *agent.LLM
	trace base.Journal

	// mu guards what the lines handled and the words said share.
	mu sync.Mutex
	// picked: the helper picked in the chat for the line being handled.
	picked string
	// quiet: the current run came from voice; its words stay off the farm (the voice agent answered already).
	quiet bool
	// replyTo: where the manager's words go, the conversation it is answering.
	replyTo int64
	caller  *foremanCaller
	// toCaller: how much of the message being said has gone to the caller (bytes).
	toCaller int
	// said, open: each of its messages has a key of its own; open while one is being said.
	said     int
	open     bool
	lastPush time.Time

	// starting: one brain start at a time. A brain that could not start (no key yet) is tried again on the next line.
	starting sync.Mutex
	brain    *agent.Agent
	stops    []func()
}

// foremanIn is what the manager is built from: everything it reads before a request, and the services its tools
// act through.
type foremanIn struct {
	fx.In
	Config       base.Config
	Site         *base.Site
	Store        *base.Store
	Settings     *base.Settings
	Runtimes     *runs.Runtimes
	Trajectories *runs.Trajectories
	Projects     *projects.Projects
	Crew         *runs.Crew
	Dispatch     *tickets.Dispatch
	Merges       *tickets.Merges
	Chat         *chat.Chat
	Playbooks    *tickets.Playbooks
	Schedules    *tickets.Schedules
	Heartbeat    *tickets.Heartbeat
}

func newForeman(in foremanIn) (*Foreman, error) {
	return &Foreman{
		cfg: in.Config, site: in.Site, store: in.Store, settings: in.Settings, runtimes: in.Runtimes, trajectories: in.Trajectories,
		projects: in.Projects, crew: in.Crew, dispatch: in.Dispatch, merges: in.Merges, chat: in.Chat, playbooks: in.Playbooks, schedules: in.Schedules, heartbeat: in.Heartbeat,
		runtime: memory.ForemanRuntime(), model: strings.TrimSpace(os.Getenv("VIBEVALLEY_FOREMAN_MODEL")), ctx: context.Background(),
	}, nil
}

// start listens to what wakes the manager: the chat, schedules come due, the heartbeat, playbooks.
func (fm *Foreman) OnStart(ctx context.Context) error {
	fm.ctx = ctx
	fm.replyTo = fm.chat.Square()
	if fm.trace == nil {
		fm.trace = fm.trajectories.Open(protocol.TrajectoryHead{ID: memory.ManagerAgent, Name: "管家", StartedAt: base.NowMs()}, foremanSteps)
	}
	// In a test that gave the manager no model, it hears nothing: the other services' tests run as without it, and
	// nothing reaches DeepSeek (a key in the environment would be used otherwise).
	if fm.llm == nil && testing.Testing() {
		return nil
	}
	foremanListen(fm, ctx, fm.chat.ForForeman(), fm.heardInChat)
	foremanListen(fm, ctx, fm.schedules.Due(), fm.onDue)
	foremanListen(fm, ctx, fm.heartbeat.News(), func(n base.PatrolNews) { fm.send(n.Text, n.Channel, false) })
	foremanListen(fm, ctx, fm.playbooks.News(), func(line string) { fm.send(line, fm.chat.Square(), false) })
	return nil
}

// foremanListen handles what a hub publishes, one at a time, until ctx ends.
func foremanListen[T any](fm *Foreman, ctx context.Context, hub *base.Hub[T], handle func(T)) {
	values, stop := hub.Subscribe()
	fm.stops = append(fm.stops, stop)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-values:
				if !ok {
					return
				}
				handle(v)
			}
		}
	}()
}

func (fm *Foreman) OnStop() {
	for _, stop := range fm.stops {
		stop()
	}
	fm.starting.Lock()
	if fm.brain != nil {
		fm.brain.Close()
	}
	fm.starting.Unlock()
}

func (fm *Foreman) here() int64 {
	fm.mu.Lock()
	defer fm.mu.Unlock()
	return fm.replyTo
}

// ── Who goes, and what the manager is told ───────────────────────────────────

type foremanAgentInfo struct {
	agent    protocol.AgentProfile
	info     *protocol.RuntimeInfo
	blocking []protocol.AgentIssue
}

func (fm *Foreman) agentsWithIssues() []foremanAgentInfo {
	var out []foremanAgentInfo
	for _, a := range fm.store.Agents() {
		info := fm.runtimes.Info(fm.ctx, a.Runtime)
		var blocking []protocol.AgentIssue
		for _, i := range protocol.AgentIssues(a, info) {
			if i.Level == "error" {
				blocking = append(blocking, i)
			}
		}
		out = append(out, foremanAgentInfo{a, info, blocking})
	}
	return out
}

func foremanUsable(a foremanAgentInfo) bool { return a.agent.Enabled && len(a.blocking) == 0 }

// choose is who goes when the manager names named (or no one) for task, by the farm's rules: named, picked in the
// chat, then the best tag match.
func (fm *Foreman) choose(task, named string) *protocol.AgentProfile {
	var candidates []runs.Candidate
	for _, a := range fm.agentsWithIssues() {
		candidates = append(candidates, runs.Candidate{Agent: a.agent, Usable: foremanUsable(a)})
	}
	fm.mu.Lock()
	picked := fm.picked
	fm.mu.Unlock()
	return runs.ChooseAgent(candidates, task, named, picked)
}

// foremanQuota is what is left on an agent's runtime, as the manager reads it.
func foremanQuota(info *protocol.RuntimeInfo) string {
	var usage protocol.AccountUsage
	budget := 0.0
	var spentToday *float64
	if info != nil {
		usage = info.Usage
		spentToday = info.SpentToday
		if info.Settings.DailyBudget != nil {
			budget = *info.Settings.DailyBudget
		}
	}
	low := ""
	if left, ok := protocol.QuotaLeft(usage); ok && left < protocol.QuotaLow {
		low = "（快用完了）"
	}
	today := ""
	if spentToday != nil || budget > 0 {
		spent := 0.0
		if spentToday != nil {
			spent = *spentToday
		}
		today = "，今天花了 " + protocol.Yuan(spent)
		if budget > 0 {
			today += "（每日预算 " + protocol.Yuan(budget) + "）"
		}
	}
	return "额度：" + protocol.QuotaText(usage) + low + today
}

// situation is what the manager is told before each request: the helpers it can send, who is where, playbooks.
func (fm *Foreman) situation() string {
	var helpers []string
	for _, a := range fm.agentsWithIssues() {
		line := fmt.Sprintf("- %s（id %s，%s）适合：%s", a.agent.Name, a.agent.ID, protocol.RuntimeLabel(a.agent.Runtime), a.agent.Role)
		if len(a.agent.Tags) > 0 {
			line += "；关键词：" + strings.Join(a.agent.Tags, "、")
		}
		switch {
		case foremanUsable(a):
			line += "；" + foremanQuota(a.info)
		case len(a.blocking) > 0:
			line += "；现在派不了：" + a.blocking[0].Text
		default:
			line += "；现在派不了：停用了"
		}
		helpers = append(helpers, line)
	}
	roster := fm.crew.Roster()
	here := fm.chat.ChannelOf(fm.here())
	var byChannel []string
	for _, c := range fm.chat.Channels() {
		var theirs []string
		for _, w := range roster {
			channel := fm.chat.Square()
			if w.Helper.Channel != nil {
				channel = *w.Helper.Channel
			}
			if channel == c.ID {
				theirs = append(theirs, foremanDescribeWorker(w))
			}
		}
		head := "#" + c.Name
		if c.ID == here.ID {
			head += "（你正在回话的频道）"
		}
		if c.Description != "" {
			head += "：" + c.Description
		}
		if c.Project != "" {
			head += "；默认项目 " + c.Project
		}
		body := "  （没有帮工）"
		if len(theirs) > 0 {
			body = strings.Join(theirs, "\n")
		}
		byChannel = append(byChannel, head+"\n"+body)
	}
	folders := "（还没有）"
	if all := fm.projects.List(); len(all) > 0 {
		names := make([]string, len(all))
		for i, p := range all {
			names[i] = p.Name
		}
		folders = strings.Join(names, "、")
	}
	plans := ""
	var open []string
	for _, pb := range protocol.PlaybooksOf(fm.site.State()) {
		if protocol.IsOpen(pb) {
			open = append(open, protocol.PlaybookText(pb))
		}
	}
	if len(open) > 0 {
		plans = "\n种植计划：\n" + strings.Join(open, "\n")
	}
	return "【农场现状】\n项目（工作目录 " + fm.projects.Root() + " 下的文件夹）：" + folders + "\n可以派的帮工：\n" + strings.Join(helpers, "\n") +
		"\n各频道和地里的帮工：\n" + strings.Join(byChannel, "\n") + plans
}

// news is what reached the manager without waking it (helpers' reports, mostly), taken once; "" when nothing.
func (fm *Foreman) news() string {
	digest := fm.chat.ForemanDigest()
	if len(digest) == 0 {
		return ""
	}
	return "这期间田头上的汇报（不用逐条转述，主人问到再说）：\n" + base.InboxLines(digest)
}

// ── The brain ────────────────────────────────────────────────────────────────

// foremanDeepseekModel is the DeepSeek model a configured name means: `deepseek/<id>` or `<id>`; another provider's
// is pi's to run.
func foremanDeepseekModel(configured string) (string, error) {
	if configured == "" {
		return agent.DEFAULT_MODEL, nil
	}
	provider, rest, found := strings.Cut(configured, "/")
	if !found {
		return configured, nil
	}
	if provider == "deepseek" {
		return rest, nil
	}
	return "", errors.New("管家只接 DeepSeek 的模型：VIBEVALLEY_FOREMAN_MODEL 设成 deepseek/<模型> 或直接写模型名，" + configured + " 用不了")
}

// brainOf is the manager's agent, started on first use: loading it is not free, and a farm without a model works
// otherwise. Only one that started is kept.
func (fm *Foreman) brainOf() (*agent.Agent, error) {
	fm.starting.Lock()
	defer fm.starting.Unlock()
	if fm.brain != nil {
		return fm.brain, nil
	}
	if fm.runtime == protocol.RuntimePi {
		return nil, errors.New("Go 版服务端的管家还不能在 pi 上跑：去掉 VIBEVALLEY_FOREMAN_RUNTIME=pi，用 VibeValley 自己的 agent")
	}
	options := agent.AgentOptions{
		Name:         "manager",
		Instructions: foremanSystemPrompt + foremanAgentPrompt,
		Home:         memory.ForemanHome(fm.cfg.Home),
		Cwd:          fm.cfg.WorkRoot,
		Tools:        fm.tools(),
		NoSkills:     true,
		NoSubagents:  true,
		Schedules:    new(false),
		Situation:    func(context.Context) string { return fm.situation() },
	}
	if fm.llm == nil && testing.Testing() {
		// A test that did not give the manager a model never reaches DeepSeek (or spends money).
		return nil, errors.New("测试里管家没有模型")
	}
	if fm.llm != nil {
		options.Model, options.StreamOptions = fm.llm.Model, fm.llm.StreamOptions
	} else {
		id, err := foremanDeepseekModel(fm.model)
		if err != nil {
			return nil, err
		}
		llm, err := agent.Deepseek(id, fm.settings.DeepseekAPIKey())
		if err != nil {
			return nil, err
		}
		options.Model, options.StreamOptions = llm.Model, llm.StreamOptions
		// The key saved in settings, asked before each request: one saved while the manager runs is used at once.
		options.GetApiKey = func(context.Context, string) string { return fm.settings.DeepseekAPIKey() }
	}
	a := agent.NewAgent(fm.ctx, options)
	// The subscription is open before the first line is sent.
	events := a.Subscribe()
	go fm.follow(events)
	log.Printf("vibevalley: the manager is on vibevalley's own agent, model %s", options.Model.ID)
	fm.brain = a
	return a, nil
}

// follow turns the agent's events into the manager's words on the farm and its trajectory, in order.
func (fm *Foreman) follow(events *agentcore.Subscription[agent.AgentEvent]) {
	defer events.Close()
	for {
		select {
		case <-fm.ctx.Done():
			return
		case e, ok := <-events.C:
			if !ok {
				return
			}
			fm.event(e)
		}
	}
}

func (fm *Foreman) event(e agent.AgentEvent) {
	switch e.Type {
	case agentcore.EventAgentStart:
		fm.site.SetForeman(protocol.ForemanStateThinking)
	case agentcore.EventMessageUpdate:
		if e.Message == nil || e.Message.Role() != "assistant" {
			return
		}
		if text := agent.MessageText(e.Message); text != "" {
			fm.grow(text)
		}
	case agentcore.EventMessageEnd:
		m, ok := e.Message.(ai.AssistantMessage)
		if !ok {
			return
		}
		text := strings.TrimSpace(agent.MessageText(m))
		if thinking := foremanThinkingOf(m.Content); thinking != "" {
			fm.trace.Thought(thinking, nil)
		}
		fm.trace.Said(text, nil)
		why := m.ErrorMessage
		if why == "" {
			why = "模型出错了"
		}
		if m.StopReason == ai.StopError {
			fm.trace.Note(protocol.StepKindProblem, why, nil)
		}
		fm.done(text)
		if m.StopReason == ai.StopError {
			fm.site.Notice(protocol.NoticeLevelError, "管家出错了："+why)
		}
	case agent.EventAgentSettled:
		fm.settled()
	case agentcore.EventToolExecutionStart:
		fm.trace.ToolStarted(e.ToolCallID, foremanToolStart(e.ToolName, e.Args), nil)
	case agentcore.EventToolExecutionEnd:
		result := ""
		if e.Result != nil {
			result = agentcore.ResultText(e.Result.Content)
		}
		fm.trace.ToolEnded(e.ToolCallID, result, !e.IsError, nil)
	}
}

// ── Its words onto the farm (the mouth) ──────────────────────────────────────

// keyLocked is the key of the message being said: a new one when none is open.
func (fm *Foreman) keyLocked() string {
	if !fm.open {
		fm.open = true
		fm.said++
	}
	return fmt.Sprintf("m%d", fm.said)
}

// grow: the message being said, so far.
func (fm *Foreman) grow(text string) {
	fm.mu.Lock()
	if fm.caller != nil && len(text) > fm.toCaller {
		fm.caller.push(text[fm.toCaller:])
		fm.toCaller = len(text)
	}
	key := fm.keyLocked()
	if fm.quiet || time.Since(fm.lastPush) < foremanStreamEvery {
		fm.mu.Unlock()
		return
	}
	fm.lastPush = time.Now()
	to := fm.replyTo
	fm.mu.Unlock()
	fm.site.SetForeman(protocol.ForemanStateSpeaking)
	fm.chat.ForemanSays(to, key, text, false)
}

// done: a message said in full.
func (fm *Foreman) done(text string) {
	fm.mu.Lock()
	// The rest of this message to the caller, and a pause before the next (it may speak again after a tool).
	if fm.caller != nil && len(text) > fm.toCaller {
		fm.caller.push(text[fm.toCaller:])
	}
	if fm.caller != nil && text != "" {
		fm.caller.push("\n")
	}
	fm.toCaller = 0
	key := fm.keyLocked()
	fm.open = false
	quiet, to := fm.quiet, fm.replyTo
	fm.mu.Unlock()
	if text != "" && !quiet {
		fm.chat.ForemanSays(to, key, text, true)
	}
}

// settled: the run is over, nothing more queued.
func (fm *Foreman) settled() {
	fm.mu.Lock()
	if fm.caller != nil {
		fm.caller.end()
	}
	fm.caller = nil
	fm.quiet = false
	fm.picked = ""
	fm.open = false
	fm.mu.Unlock()
	fm.site.SetForeman(protocol.ForemanStateListening)
}

// send hands a line to the manager in conversation: now joins the run under way (the person's words); otherwise it
// waits until the run would stop (a schedule, a playbook's notice, a helper's report).
func (fm *Foreman) send(line string, conversation int64, now bool) {
	fm.trace.Asked(line, nil)
	brain, err := fm.brainOf()
	if err != nil {
		fm.trace.Note(protocol.StepKindProblem, "起不来："+err.Error(), nil)
		fm.site.Notice(protocol.NoticeLevelError, "管家起不来："+err.Error())
		said := "我这边起不来：" + err.Error()
		if errors.Is(err, agent.ErrNoDeepSeekKey) {
			said = "我还没有 DeepSeek 的钥匙，想不了事。到首页的「设置」里填上 DeepSeek 的 API Key（工作台左栏最下面的「设置」也能去），填好再跟我说一遍。"
		}
		fm.chat.ForemanSays(conversation, fmt.Sprintf("failed%d", base.NowMs()), said, true)
		// A call waiting for words hears why, and is done.
		fm.mu.Lock()
		if fm.caller != nil {
			fm.caller.push("我这边起不来：" + err.Error())
			fm.caller.end()
			fm.caller = nil
		}
		fm.mu.Unlock()
		return
	}
	fm.mu.Lock()
	fm.replyTo = conversation
	fm.mu.Unlock()
	deliver := brain.Later
	if now {
		deliver = brain.Send
	}
	if heard := fm.news(); heard != "" {
		deliver(agent.NewCustomMessage("farmNews", ai.StringContent(heard), agent.CustomMessageOptions{Hidden: true}))
	}
	deliver(agent.UserMessage(line))
}

// pickedNote is the line saying which helper the person picked in the chat; "" when none.
func (fm *Foreman) pickedNote(picked string) string {
	if picked == "" {
		return ""
	}
	if a := fm.store.Agent(picked); a != nil {
		return "（主人在对话框里选定了帮工：" + a.Name + "）\n"
	}
	return ""
}

// heardInChat is what the chat brings the manager: the person's words for it, an @管家, a helper that failed. A
// person asking is answered at once; a helper's report waits until the manager is free.
func (fm *Foreman) heardInChat(news base.ForemanNews) {
	fromPerson := !slices.ContainsFunc(news.Messages, func(m base.InboxMessage) bool { return m.From != "user" })
	if fromPerson && news.Conversation == fm.chat.Square() {
		fm.mu.Lock()
		picked := fm.picked
		fm.mu.Unlock()
		words := make([]string, len(news.Messages))
		for i, m := range news.Messages {
			words[i] = m.Text
		}
		fm.send(fm.pickedNote(picked)+"主人说："+strings.Join(words, "\n"), news.Conversation, true)
		return
	}
	fm.send("【田头】"+news.Target+" 里有给你的话：\n"+base.InboxLines(news.Messages)+"\n\n你的回答会发在 "+news.Target+"。", news.Conversation, fromPerson)
}

// onDue is a schedule come due (its notice is in the channel already): the manager is asked, in that channel, when it
// is free. One naming an agent is a recurring issue, Dispatch's.
func (fm *Foreman) onDue(due base.Due) {
	s := due.Schedule
	channel := fm.chat.ChannelOf(s.Channel)
	if s.Agent != nil {
		return
	}
	missed := ""
	if due.Missed {
		missed = "（服务端没开着时错过的，补一次）"
	}
	fm.send(fmt.Sprintf("【定时任务「%s」到点了%s】\n%s\n\n这是 #%s 的定时（%d 号），你的回答会发在那里；照着做，做完说一两句。", s.Name, missed, s.Text, channel.Name, s.ID), channel.ID, false)
}

// ── What the farm asks of it ─────────────────────────────────────────────────

// Say is the person saying something in the chat (the square, or conversation). It reaches the manager only when
// it is for the manager (the chat decides). agent is the helper picked in the chat, if any.
func (fm *Foreman) Say(ctx context.Context, text, agentID string, conversation *int64) error {
	picked := ""
	if a := fm.store.Agent(agentID); agentID != "" && a != nil {
		picked = a.ID
	}
	fm.mu.Lock()
	fm.picked = picked
	fm.mu.Unlock()
	_, err := fm.chat.Say(text, conversation)
	return err
}

// Heard is something said to the voice agent, which already answered out loud: the manager acts on it, in
// silence. When the manager answers calls itself, what was said reached it on the voice line already.
func (fm *Foreman) Heard(text, agentID string) {
	if _, ok := fm.settings.Voice().LLM.Value.(protocol.VoiceLLMVibeValley); ok {
		return
	}
	picked := ""
	if a := fm.store.Agent(agentID); agentID != "" && a != nil {
		picked = a.ID
	}
	fm.mu.Lock()
	fm.picked = picked
	fm.quiet = true
	fm.mu.Unlock()
	fm.send(fm.pickedNote(picked)+"（这句话是主人用语音说的，语音那边已经回答了。你只要按需派活，不用回复。）\n主人说："+text, fm.chat.Square(), true)
}

// Call is something said on a call the manager answers itself (the voice line): its words for this turn, as they
// grow, to be read out; the channel closes when the turn settles, or ctx ends. A newer line on the call ends the one
// before.
func (fm *Foreman) Call(ctx context.Context, text string) <-chan string {
	out := make(chan string)
	me := &foremanCaller{signal: make(chan struct{}, 1)}
	fm.mu.Lock()
	if fm.caller != nil {
		fm.caller.end()
	}
	fm.caller = me
	fm.toCaller = 0
	fm.mu.Unlock()
	go me.pump(ctx, out)
	go func() {
		<-ctx.Done()
		fm.mu.Lock()
		if fm.caller == me {
			fm.caller = nil
		}
		fm.mu.Unlock()
	}()
	go fm.send(foremanVoiceNote+"\n主人说："+text, fm.chat.Square(), true)
	return out
}
