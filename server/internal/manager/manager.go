package manager

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.uber.org/fx"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/issue"
	"vibevalley/internal/memory"
	"vibevalley/internal/playbook"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/session"
	"vibevalley/internal/setting"
	vvagent "vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/x/clock"
)

// The farm's situation goes in the system prompt of every request, never in the conversation; what reached the manager without waking it goes in as
// hidden farmNews messages, kept. The manager on pi is refused.

const (
	keepManagerEvents  = 1000
	managerStreamEvery = 120 * time.Millisecond
)

const managerVoiceNote = "（这句话是主人在电话里说的，你的回答会念给主人听：口语，一两句，先说结论；不念代码、路径、命令和长列表。要用工具时可以先说一句「我看一下」。）"

const managerSystemPrompt = `你是码农场物语的管家。主人跟你说要做的活，你派农场里的帮工去做。帮工是真实的编码 agent（Claude Code、Codex、pi 等），在主人电脑上的目录里改代码、跑命令。你自己不写代码、不读文件，只派活、盯进度、转告结果。

怎么做：
- 主人要做一件事：用 dispatch 派活。工单要写清楚目标、做到什么程度算完。互不相关的几件事可以派给几个帮工。
- 每件活都在一个项目里做：项目就是工作目录下的一个文件夹（「农场现状」里列着）。主人说的项目没有，就新建：起一个简短的英文名（比如 clock-in），dispatch 时填上它，农场会建好文件夹和 git 仓库。拿不准是哪个项目就先问主人。
- 帮工在项目里各自的分支上干活，做完会提交。主人说「收下」「合进去」，或者你确认活做好了、主人也满意，就用 merge 把它的分支合进项目，帮工随后收工。只想打发走、不要它的改动，用 dismiss（分支会留着）。主人问改了什么，用 changes。
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
- 计划开工以后由农场自己调度：前面的步骤合进计划分支，后面的才开工。计划里的帮工不要用 dispatch、merge、dismiss 去管。有步骤没做成，问主人是重试（node_action retry）、改工单，还是跳过（node_action skip）。
- 计划都做完了（等收获）：主人说收，就用 plan_action merge 把整个计划合进主分支。
- 收到「【种植计划】」开头的消息：照里面说的，用一两句话告诉主人。
- 收到「【巡查】」开头的消息：那是农场自己看出来放着没人管的事。值得提醒就在那个频道里用一两句话提醒主人（问题没人回、活做完了没收、步骤没做成），帮工没动静就看看要不要叫停；不值得就什么也别说。
- 定时：主人说「每天」「每周几」「到点」「过一会儿」「每隔多久」，用 schedule 定在一个频道里（不填就是你正在回话的频道）。到点时频道里先出现一条「⏰ 定时……」，然后你会收到「【定时任务……】」开头的那句话，照着做（派活、看进度、提醒主人），做完说一两句。写了 agent 的定时到点直接派活，不经过你。看有哪些用 list_schedules，不要了用 cancel_schedule。

说话：中文，口语，简短，一般一两句。需要列点时可以用 Markdown，但不要贴大段代码。只说工具结果和汇报里有的东西，不要编造进度、文件名或结果。`

const managerAgentPrompt = `
记性：
- 主人说「记住」「以后都」，或者告诉你一个以后还用得上的偏好、约定：用 remember 记一句。记下的每次都在你的系统提示里。`

type managerCaller struct {
	mu     sync.Mutex
	queue  []string
	ended  bool
	signal chan struct{}
}

func (c *managerCaller) push(text string) {
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

func (c *managerCaller) end() {
	c.mu.Lock()
	c.ended = true
	c.mu.Unlock()
	select {
	case c.signal <- struct{}{}:
	default:
	}
}

func (c *managerCaller) pump(ctx context.Context, out chan<- string) {
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

type manager struct {
	cfg       base.Config
	core      *core.Service
	store     *agent.Service
	settings  *setting.Service
	runtimes  *runtime.Service
	projects  *project.Service
	run       *session.Service
	issue     *issue.Service
	chat      *channel.Service
	playbooks *playbook.Service
	schedule  *schedule.Service
	patrol    *patrol
	ctx       context.Context

	// Stand-ins for tests: llm nil is DeepSeek; trace nil is opened at start.
	llm   *vvagent.LLM
	trace session.Journal

	// Guards what the lines handled and the words said share.
	mu sync.Mutex
	// The runs of issues for it under way, ended when its run settles.
	working []managerRun
	picked  string
	// The current run came from voice: its words stay off the farm, the voice agent answered already.
	quiet   bool
	replyTo int64
	caller  *managerCaller
	// In bytes.
	toCaller int
	said     int
	open     bool
	lastPush time.Time

	// A brain that could not start (no key yet) is tried again on the next line.
	starting sync.Mutex
	brain    *vvagent.Agent
	stops    []func()
}

type managerIn struct {
	fx.In
	Config   base.Config
	Core     *core.Service
	Agent    *agent.Service
	Setting  *setting.Service
	Runtime  *runtime.Service
	Project  *project.Service
	Run      *session.Service
	Issue    *issue.Service
	Channel  *channel.Service
	Playbook *playbook.Service
	Schedule *schedule.Service
}

func newManager(in managerIn) (*manager, error) {
	return &manager{
		cfg: in.Config, core: in.Core, store: in.Agent, settings: in.Setting, runtimes: in.Runtime,
		projects: in.Project, run: in.Run, issue: in.Issue, chat: in.Channel, playbooks: in.Playbook, schedule: in.Schedule,
		ctx: context.Background(),
	}, nil
}

func (fm *manager) OnStart(ctx context.Context) error {
	fm.ctx = ctx
	fm.replyTo = fm.chat.General()
	if fm.trace == nil {
		fm.trace = fm.run.Open(protocol.ManagerAgent, keepManagerEvents)
	}
	// In a test that gave the manager no model, it hears nothing: the other services' tests run as without it, and
	// nothing reaches DeepSeek (a key in the environment would be used otherwise).
	if fm.llm == nil && testing.Testing() {
		return nil
	}
	managerListen(fm, ctx, fm.chat.ForManager(), fm.heardInChat)
	managerListen(fm, ctx, fm.issue.ForManager(), fm.onWork)
	managerListen(fm, ctx, fm.patrol.News(), func(n PatrolNews) { fm.send(n.Text, n.Channel, false) })
	managerListen(fm, ctx, fm.playbooks.News(), func(line string) { fm.send(line, fm.chat.General(), false) })
	return nil
}

func managerListen[T any](fm *manager, ctx context.Context, hub *base.Hub[T], handle func(T)) {
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

func (fm *manager) OnStop() {
	for _, stop := range fm.stops {
		stop()
	}
	fm.starting.Lock()
	if fm.brain != nil {
		fm.brain.Close()
	}
	fm.starting.Unlock()
}

func (fm *manager) here() int64 {
	fm.mu.Lock()
	defer fm.mu.Unlock()
	return fm.replyTo
}

type managerAgentInfo struct {
	agent    protocol.Agent
	info     *protocol.RuntimeInfo
	blocking []protocol.AgentIssue
}

func (fm *manager) agentsWithIssues() []managerAgentInfo {
	var out []managerAgentInfo
	for _, a := range fm.store.Agents() {
		info := fm.runtimes.Info(fm.ctx, a.Runtime)
		var blocking []protocol.AgentIssue
		for _, i := range fm.runtimes.Check(fm.ctx, a) {
			if i.Level == "error" {
				blocking = append(blocking, i)
			}
		}
		out = append(out, managerAgentInfo{a, info, blocking})
	}
	return out
}

func managerUsable(a managerAgentInfo) bool { return a.agent.Enabled && len(a.blocking) == 0 }

func (fm *manager) choose(task, named string) *protocol.Agent {
	var candidates []session.Candidate
	for _, a := range fm.agentsWithIssues() {
		candidates = append(candidates, session.Candidate{Agent: a.agent, Usable: managerUsable(a)})
	}
	fm.mu.Lock()
	picked := fm.picked
	fm.mu.Unlock()
	return session.ChooseAgent(candidates, task, named, picked)
}

func managerQuota(info *protocol.RuntimeInfo) string {
	budget := 0.0
	var spentToday *float64
	if info != nil {
		spentToday = info.SpentToday
		if info.Settings.DailyBudget != nil {
			budget = *info.Settings.DailyBudget
		}
	}
	low := ""
	if info != nil && info.Quota != nil && info.Quota.Left != nil && *info.Quota.Left < protocol.QuotaLow {
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
	words := "不报额度"
	if info != nil && info.Quota != nil {
		words = info.Quota.Text
	}
	return "额度：" + words + low + today
}

func (fm *manager) situation() string {
	var sessions []string
	for _, a := range fm.agentsWithIssues() {
		line := fmt.Sprintf("- %s（id %s，%s）适合：%s", a.agent.Name, a.agent.ID, protocol.RuntimeLabel(a.agent.Runtime), a.agent.Role)
		if len(a.agent.Tags) > 0 {
			line += "；关键词：" + strings.Join(a.agent.Tags, "、")
		}
		switch {
		case managerUsable(a):
			line += "；" + managerQuota(a.info)
		case len(a.blocking) > 0:
			line += "；现在派不了：" + a.blocking[0].Text
		default:
			line += "；现在派不了：停用了"
		}
		sessions = append(sessions, line)
	}
	roster := fm.run.Roster()
	here := fm.chat.ChannelOf(fm.here())
	var byChannel []string
	for _, c := range fm.chat.Channels() {
		var theirs []string
		for _, w := range roster {
			channel := fm.chat.General()
			if w.Session.Channel != nil {
				channel = *w.Session.Channel
			}
			if channel == c.ID {
				theirs = append(theirs, managerDescribeSession(w))
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
	for _, pb := range protocol.PlaybooksOf(fm.core.State()) {
		if protocol.IsOpen(pb) {
			open = append(open, protocol.PlaybookText(pb))
		}
	}
	if len(open) > 0 {
		plans = "\n种植计划：\n" + strings.Join(open, "\n")
	}
	return "【农场现状】\n项目（工作目录 " + fm.projects.Root() + " 下的文件夹）：" + folders + "\n可以派的帮工：\n" + strings.Join(sessions, "\n") +
		"\n各频道和地里的帮工：\n" + strings.Join(byChannel, "\n") + plans
}

func (fm *manager) news() string {
	digest := fm.chat.ManagerDigest()
	if len(digest) == 0 {
		return ""
	}
	return "这期间田头上的汇报（不用逐条转述，主人问到再说）：\n" + protocol.InboxLines(digest)
}

func managerDeepseekModel(configured string) (string, error) {
	if configured == "" {
		return vvagent.DEFAULT_MODEL, nil
	}
	provider, rest, found := strings.Cut(configured, "/")
	if !found {
		return configured, nil
	}
	if provider == "deepseek" {
		return rest, nil
	}
	return "", errors.New("管家只接 DeepSeek 的模型：管家档案的模型设成 deepseek/<模型> 或直接写模型名，" + configured + " 用不了")
}

// The model in the manager's profile; read when the manager starts, so a change is used from its next start.
func (fm *manager) modelOf() string {
	if a := fm.store.Agent(protocol.ManagerAgent); a != nil {
		return strings.TrimSpace(a.Model)
	}
	return ""
}

// Started on first use: loading it is not free, and a farm without a model works otherwise.
func (fm *manager) brainOf() (*vvagent.Agent, error) {
	fm.starting.Lock()
	defer fm.starting.Unlock()
	if fm.brain != nil {
		return fm.brain, nil
	}
	options := vvagent.AgentOptions{
		Name:         protocol.ManagerAgent,
		Instructions: managerSystemPrompt + managerAgentPrompt,
		Home:         memory.ManagerHome(fm.cfg.Home),
		Cwd:          fm.cfg.WorkRoot,
		Tools:        fm.tools(),
		NoSkills:     true,
		NoSubagents:  true,
		Schedules:    new(false),
		Situation:    func(context.Context) string { return fm.situation() },
	}
	if fm.llm != nil {
		options.Model, options.StreamOptions = fm.llm.Model, fm.llm.StreamOptions
	} else {
		id, err := managerDeepseekModel(fm.modelOf())
		if err != nil {
			return nil, err
		}
		if testing.Testing() {
			return nil, errors.New("测试里管家没有模型")
		}
		llm, err := vvagent.Deepseek(id, fm.settings.DeepseekAPIKey())
		if err != nil {
			return nil, err
		}
		options.Model, options.StreamOptions = llm.Model, llm.StreamOptions
		// The key saved in settings, asked before each request: one saved while the manager runs is used at once.
		options.GetApiKey = func(context.Context, string) string { return fm.settings.DeepseekAPIKey() }
	}
	a := vvagent.NewAgent(fm.ctx, options)
	// The subscription is open before the first line is sent.
	events := a.Subscribe()
	go fm.follow(events)
	log.Printf("vibevalley: the manager is on vibevalley's own agent, model %s", options.Model.ID)
	fm.brain = a
	return a, nil
}

func (fm *manager) follow(events *agentcore.Subscription[vvagent.AgentEvent]) {
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

func (fm *manager) event(e vvagent.AgentEvent) {
	switch e.Type {
	case agentcore.EventAgentStart:
		fm.core.SetManager(protocol.ManagerStateThinking)
	case agentcore.EventMessageUpdate:
		if e.Message == nil || e.Message.Role() != "assistant" {
			return
		}
		if text := vvagent.MessageText(e.Message); text != "" {
			fm.grow(text)
		}
	case agentcore.EventMessageEnd:
		m, ok := e.Message.(ai.AssistantMessage)
		if !ok {
			return
		}
		text := strings.TrimSpace(vvagent.MessageText(m))
		if thinking := managerThinkingOf(m.Content); thinking != "" {
			fm.trace.Thought(thinking, nil)
		}
		fm.trace.Said(text, nil)
		why := m.ErrorMessage
		if why == "" {
			why = "模型出错了"
		}
		if m.StopReason == ai.StopError {
			fm.trace.Note(protocol.SessionEventTypeRunError, why, nil)
		}
		fm.done(text)
		if m.StopReason == ai.StopError {
			fm.core.Notice(protocol.NoticeLevelError, "管家出错了："+why)
		}
	case vvagent.EventAgentSettled:
		fm.settled()
	case agentcore.EventToolExecutionStart:
		fm.trace.ToolStarted(e.ToolCallID, managerToolStart(e.ToolName, e.Args), nil)
	case agentcore.EventToolExecutionEnd:
		result := ""
		if e.Result != nil {
			result = agentcore.ResultText(e.Result.Content)
		}
		fm.trace.ToolEnded(e.ToolCallID, result, !e.IsError, nil)
	}
}

func (fm *manager) keyLocked() string {
	if !fm.open {
		fm.open = true
		fm.said++
	}
	return fmt.Sprintf("m%d", fm.said)
}

func (fm *manager) grow(text string) {
	fm.mu.Lock()
	if fm.caller != nil && len(text) > fm.toCaller {
		fm.caller.push(text[fm.toCaller:])
		fm.toCaller = len(text)
	}
	key := fm.keyLocked()
	if fm.quiet || time.Since(fm.lastPush) < managerStreamEvery {
		fm.mu.Unlock()
		return
	}
	fm.lastPush = time.Now()
	to := fm.replyTo
	fm.mu.Unlock()
	fm.core.SetManager(protocol.ManagerStateSpeaking)
	fm.chat.ManagerSays(to, key, text, false)
}

func (fm *manager) done(text string) {
	fm.mu.Lock()
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
		fm.chat.ManagerSays(to, key, text, true)
	}
}

func (fm *manager) settled() {
	fm.mu.Lock()
	if fm.caller != nil {
		fm.caller.end()
	}
	fm.caller = nil
	fm.quiet = false
	fm.picked = ""
	fm.open = false
	fm.mu.Unlock()
	fm.answered(protocol.OutcomeCompleted)
	fm.core.SetManager(protocol.ManagerStateListening)
}

// now joins the run under way; otherwise the line waits until the run would stop. false: the manager could not start.
func (fm *manager) send(line string, conversation int64, now bool) bool {
	fm.trace.Asked(line, nil)
	brain, err := fm.brainOf()
	if err != nil {
		fm.trace.Note(protocol.SessionEventTypeRunError, "起不来："+err.Error(), nil)
		fm.core.Notice(protocol.NoticeLevelError, "管家起不来："+err.Error())
		said := "我这边起不来：" + err.Error()
		if errors.Is(err, vvagent.ErrNoDeepSeekKey) {
			said = "我还没有 DeepSeek 的钥匙，想不了事。到首页的「设置」里填上 DeepSeek 的 API Key（工作台左栏最下面的「设置」也能去），填好再跟我说一遍。"
		}
		fm.chat.ManagerSays(conversation, fmt.Sprintf("failed%d", clock.NowMs()), said, true)
		fm.mu.Lock()
		if fm.caller != nil {
			fm.caller.push("我这边起不来：" + err.Error())
			fm.caller.end()
			fm.caller = nil
		}
		fm.mu.Unlock()
		return false
	}
	fm.mu.Lock()
	fm.replyTo = conversation
	fm.mu.Unlock()
	deliver := brain.Later
	if now {
		deliver = brain.Send
	}
	if heard := fm.news(); heard != "" {
		deliver(vvagent.NewCustomMessage("farmNews", ai.StringContent(heard), vvagent.CustomMessageOptions{Hidden: true}))
	}
	deliver(vvagent.UserMessage(line))
	return true
}

func (fm *manager) pickedNote(picked string) string {
	if picked == "" {
		return ""
	}
	if a := fm.store.Agent(picked); a != nil {
		return "（主人在对话框里选定了帮工：" + a.Name + "）\n"
	}
	return ""
}

func (fm *manager) heardInChat(news channel.ManagerNews) {
	fromPerson := !slices.ContainsFunc(news.Messages, func(m protocol.InboxMessage) bool { return m.From != "user" })
	if fromPerson && news.Conversation == fm.chat.General() {
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
	fm.send("【田头】"+news.Target+" 里有给你的话：\n"+protocol.InboxLines(news.Messages)+"\n\n你的回答会发在 "+news.Target+"。", news.Conversation, fromPerson)
}

// A run of an issue for the manager lasts until the manager's run that takes the line settles.
func (fm *manager) onWork(w issue.ManagerWork) {
	channel := fm.chat.ChannelOf(w.Channel)
	line := fmt.Sprintf("【工单「%s」交给你了】\n%s\n\n你的回答会发在 #%s；照着做，做完说一两句。", w.Issue.Title, w.Issue.Description, channel.Name)
	if s := w.Schedule; s != nil {
		missed := ""
		if w.By.Missed {
			missed = "（服务端没开着时错过的，补一次）"
		}
		line = fmt.Sprintf("【定时任务「%s」到点了%s】\n%s\n\n这是 #%s 的定时（%d 号），你的回答会发在那里；照着做，做完说一两句。", s.Name, missed, s.Text, channel.Name, s.ID)
	}
	run := fm.run.OpenRun(protocol.ManagerAgent, w.Issue.ID, w.By)
	fm.mu.Lock()
	fm.working = append(fm.working, managerRun{run: run, issue: w.Issue.ID})
	fm.mu.Unlock()
	if !fm.send(line, channel.ID, false) {
		fm.answered(protocol.OutcomeFailed)
	}
}

type managerRun struct {
	run   int64
	issue string
}

func (fm *manager) answered(outcome protocol.Outcome) {
	fm.mu.Lock()
	done := fm.working
	fm.working = nil
	fm.mu.Unlock()
	for _, w := range done {
		fm.run.CloseRun(w.run, outcome, "")
		if err := fm.issue.Answered(w.issue); err != nil {
			log.Printf("vibevalley: issue %s: %v", w.issue, err)
		}
	}
}

func (fm *manager) Say(ctx context.Context, text, agentID string, conversation *int64) error {
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

// When the manager answers calls itself, what was said reached it on the voice line already.
func (fm *manager) Heard(text, agentID string) {
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
	fm.send(fm.pickedNote(picked)+"（这句话是主人用语音说的，语音那边已经回答了。你只要按需派活，不用回复。）\n主人说："+text, fm.chat.General(), true)
}

// A newer line on the call ends the one before.
func (fm *manager) Call(ctx context.Context, text string) <-chan string {
	out := make(chan string)
	me := &managerCaller{signal: make(chan struct{}, 1)}
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
	go fm.send(managerVoiceNote+"\n主人说："+text, fm.chat.General(), true)
	return out
}
