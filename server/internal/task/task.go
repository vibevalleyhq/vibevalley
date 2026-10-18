package task

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strconv"
	"strings"
	"sync"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/issue"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/session"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// TaskGraph sessions are followed through the core state's facts: a session's run ending is the cue. Everything here runs one at a time.

type taskSessions interface {
	Hire(ctx context.Context, agent protocol.Agent, task, project string, opt session.HireOptions) session.Hired
	Tell(id, text string) string
	Dismiss(id string) bool
	Find(id string) *session.Roster
	MergeInto(id, target string) ([]string, error)
}

type taskIssues interface {
	PutTask(graph protocol.TaskGraph) error
	NextTaskID() (string, error)
}

type taskProjects interface {
	Run(ctx context.Context, cwd, command string) (bool, string)
	OpenBranch(project, branch string) error
	MergeBranch(project, branch string) (string, error)
	BranchChanges(project, branch string) (protocol.Changes, error)
	ChangedFiles(cwd, base string) ([]string, error)
}

type tasks struct {
	core     *core.Service
	issues   taskIssues
	store    *agent.Service
	taskLog  *taskLog
	runtimes *runtime.Service
	// A step's run ending and the person pressing a button must not both read the same task and write over each other.
	mu            sync.Mutex
	splitters     map[string]string
	splitterTries map[string]int
	news          *base.Hub[string]
	ctx           context.Context
	stop          func()

	sessions taskSessions
	projects taskProjects
	// nil: runtime.Check. Tests put their own.
	check func(protocol.Agent) runtime.Assessment
}

type taskWork struct {
	dispatch *issue.Service
	sessions *session.Service
}

func (w taskWork) Hire(ctx context.Context, agent protocol.Agent, task, project string, opt session.HireOptions) session.Hired {
	return w.dispatch.Hire(ctx, agent, task, project, opt)
}
func (w taskWork) Tell(id, text string) string {
	return w.sessions.Tell(id, text, protocol.RunTrigger{Kind: protocol.RunTriggerKindTask})
}
func (w taskWork) Dismiss(id string) bool         { return w.sessions.Dismiss(id) }
func (w taskWork) Find(id string) *session.Roster { return w.sessions.Find(id) }
func (w taskWork) MergeInto(id, target string) ([]string, error) {
	return w.sessions.MergeInto(id, target)
}

func newTasks(core *core.Service, issues *issue.Service, store *agent.Service, log *taskLog, sessions *session.Service, projects *project.Service, runtimes *runtime.Service) (*tasks, error) {
	return &tasks{
		core: core, issues: issues, store: store, taskLog: log, runtimes: runtimes, sessions: taskWork{issues, sessions}, projects: projects,
		splitters: map[string]string{}, splitterTries: map[string]int{}, news: base.NewHub[string](), ctx: context.Background(),
	}, nil
}

func (p *tasks) assessment(a protocol.Agent) runtime.Assessment {
	if p.check != nil {
		return p.check(a)
	}
	return p.runtimes.Assess(p.ctx, a)
}

func (p *tasks) News() *base.Hub[string] { return p.news }

func taskWithNote(graph protocol.TaskGraph, note string) protocol.TaskGraph {
	graph.Note = nil
	if note != "" {
		graph.Note = &note
	}
	return graph
}

func taskUnmanned(n protocol.Task) protocol.Task {
	n.Session = nil
	return n
}

func taskStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (p *tasks) candidates() []session.Candidate {
	var out []session.Candidate
	for _, a := range p.store.Agents() {
		assessment := p.assessment(a)
		out = append(out, session.Candidate{Agent: a, Usable: assessment.Usable()})
	}
	return out
}

func (p *tasks) get(id string) *protocol.TaskGraph {
	if graph := protocol.GraphOf(p.core.State(), id); graph != nil {
		c := *graph
		return &c
	}
	return nil
}

func (p *tasks) need(id string) (protocol.TaskGraph, error) {
	if graph := p.get(id); graph != nil {
		return *graph, nil
	}
	return protocol.TaskGraph{}, fmt.Errorf("没有 %s 这个计划", id)
}

func (p *tasks) put(graph protocol.TaskGraph, by protocol.GraphActor, why string) error {
	before := p.get(graph.ID)
	if err := p.issues.PutTask(graph); err != nil {
		return fmt.Errorf("计划「%s」没能保存：%w", graph.Title, err)
	}
	p.taskLog.Record(before, graph, by, why)
	return nil
}

func (p *tasks) putFarm(graph protocol.TaskGraph) error {
	return p.put(graph, protocol.GraphActorSystem, "")
}

func (p *tasks) tellManager(text string) { p.news.Publish("【种植计划】" + text) }

func (p *tasks) giveUp(graph protocol.TaskGraph, why string) error {
	splitter := p.splitters[graph.ID]
	graph.State = protocol.GraphStateAbandoned
	if err := p.putFarm(taskWithNote(graph, why)); err != nil {
		return err
	}
	delete(p.splitters, graph.ID)
	if splitter != "" {
		p.sessions.Dismiss(splitter)
	}
	p.core.Notice(protocol.NoticeLevelWarn, "计划「"+graph.Title+"」没拆成："+why)
	p.tellManager(graph.ID + "「" + graph.Title + "」没拆成：" + why + "。问主人要不要换个说法再拆。")
	return nil
}

func (p *tasks) Split(goal, project, agent string, by protocol.GraphActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	where := strings.TrimSpace(project)
	if strings.TrimSpace(goal) == "" {
		return "", errors.New("没说要做什么")
	}
	if where == "" {
		return "", errors.New("没说在哪个项目里做：项目是工作目录下的一个文件夹")
	}
	all := p.candidates()
	chosen := session.ChooseAgent(all, "规划 计划 拆分 "+goal, agent, "")
	if chosen == nil {
		return "", errors.New("没有能派的帮工来拆计划")
	}
	id, err := p.issues.NextTaskID()
	if err != nil {
		return "", err
	}
	graph := protocol.TaskGraph{
		ID: id, Title: str.Clip(goal, 24), Goal: strings.TrimSpace(goal), Project: where,
		State: protocol.GraphStateSplitting, Tasks: []protocol.Task{}, Parallel: protocol.DefaultParallel, CreatedAt: clock.NowMs(),
	}
	if err := p.put(graph, by, ""); err != nil {
		return "", err
	}
	var usable []protocol.Agent
	for _, c := range all {
		if c.Usable {
			usable = append(usable, c.Agent)
		}
	}
	worktree := true
	hired := p.sessions.Hire(p.ctx, *chosen, session.SplitBrief(goal, where, usable), where,
		session.HireOptions{Worktree: &worktree, TaskGraph: &protocol.SessionGraph{ID: graph.ID}, Issue: graph.ID, Trigger: &protocol.RunTrigger{Kind: protocol.RunTriggerKindTask}})
	if hired.Session == nil {
		reason := hired.Refused
		if reason == "" {
			reason = "没派出去"
		}
		graph.State = protocol.GraphStateAbandoned
		if err := p.put(taskWithNote(graph, "规划的帮工派不出去："+reason), by, ""); err != nil {
			return "", err
		}
		return "", errors.New(reason)
	}
	p.splitters[graph.ID] = hired.Session.ID
	return fmt.Sprintf("%s 去看代码、拆计划了（%s）。拆好了会放在「计划」里，你看过再开工。", hired.Session.Name, graph.ID), nil
}

func (p *tasks) split(graph protocol.TaskGraph, session protocol.Session, report protocol.FactReport) error {
	if graph.State != protocol.GraphStateSplitting {
		return nil
	}
	tries := p.splitterTries[graph.ID]
	switch report.Outcome {
	case protocol.OutcomeInterrupted:
		return p.giveUp(graph, "规划被叫停了")
	case protocol.OutcomeFailed:
		if tries >= 1 {
			return p.giveUp(graph, "规划的帮工出错了："+report.Summary)
		}
		p.splitterTries[graph.ID] = tries + 1
		p.sessions.Tell(session.ID, "上一轮没做成。看一下报错，接着把计划拆完，最后用 json 代码块给出。")
		return nil
	case protocol.OutcomeCompleted:
	}
	last := ""
	if r := p.sessions.Find(session.ID); r != nil {
		last = r.LastText
	}
	parsed := parseSplit(last)
	if !parsed.OK {
		if tries >= 1 {
			first := ""
			if len(parsed.Problems) > 0 {
				first = parsed.Problems[0]
			}
			return p.giveUp(graph, "没给出能用的计划："+first)
		}
		p.splitterTries[graph.ID] = tries + 1
		lines := make([]string, len(parsed.Problems))
		for i, x := range parsed.Problems {
			lines[i] = "- " + x
		}
		p.sessions.Tell(session.ID, "计划有问题：\n"+strings.Join(lines, "\n")+"\n\n改好，在最后用一个 json 代码块重新给出整张计划。")
		return nil
	}
	draft := graph
	if parsed.Title != nil {
		draft.Title = *parsed.Title
	}
	draft.Tasks, draft.State = parsed.Tasks, protocol.GraphStateDraft
	draft = taskWithNote(draft, "")
	if err := p.putFarm(draft); err != nil {
		return err
	}
	delete(p.splitters, graph.ID)
	delete(p.splitterTries, graph.ID)
	p.sessions.Dismiss(session.ID)
	p.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("计划「%s」拆好了，%d 步：在「计划」里看过再开工", draft.Title, len(draft.Tasks)))
	p.tellManager(draft.ID + " 拆好了，等主人看过再开工（graph_action start）。用一两句话告诉主人拆成了哪几步。\n" + protocol.GraphText(draft))
	return nil
}

func (p *tasks) schedule(id string) error {
	got := p.get(id)
	if got == nil || got.State != protocol.GraphStateRunning {
		return nil
	}
	graph := *got
	for _, task := range startable(graph) {
		agent := session.ChooseAgent(p.candidates(), task.Brief, taskStr(task.Agent), "")
		refused := "没有能派的帮工"
		var hired session.Hired
		if agent != nil {
			worktree := true
			taskID := task.ID
			hired = p.sessions.Hire(p.ctx, *agent, taskBrief(graph, task), graph.Project, session.HireOptions{
				Worktree: &worktree, TaskGraph: &protocol.SessionGraph{ID: graph.ID, Task: &taskID}, Base: taskStr(graph.Branch), Trigger: &protocol.RunTrigger{Kind: protocol.RunTriggerKindTask},
				Issue: protocol.TaskIssueID(graph.ID, task.ID),
			})
			refused = hired.Refused
		}
		if hired.Session == nil {
			// Not now: it waits, and is tried again when a session finishes or leaves.
			note := "「" + task.Title + "」先等着：" + refused
			if taskStr(graph.Note) != note {
				if err := p.putFarm(taskWithNote(graph, note)); err != nil {
					return err
				}
			}
			return nil
		}
		session := hired.Session.ID
		graph = protocol.WithTask(taskWithNote(graph, ""), task.ID, func(n protocol.Task) protocol.Task {
			n.State, n.Session, n.Tries = protocol.TaskStateWorking, &session, 0
			return n
		})
		if err := p.putFarm(graph); err != nil {
			p.sessions.Dismiss(session)
			return err
		}
	}
	return nil
}

func (p *tasks) taskFailed(graph protocol.TaskGraph, task protocol.Task, why string) error {
	if err := p.putFarm(protocol.WithTask(graph, task.ID, func(n protocol.Task) protocol.Task {
		n.State, n.Conclusion = protocol.TaskStateFailed, &why
		n.Failures++
		return n
	})); err != nil {
		return err
	}
	p.core.Notice(protocol.NoticeLevelWarn, "计划「"+graph.Title+"」的「"+task.Title+"」没做成："+why)
	p.tellManager(graph.ID + " 的「" + task.Title + "」（" + task.ID + "）没做成：" + why +
		"。它后面的步骤在等；问主人是重试（task_action retry）、改工单，还是跳过（task_action skip）。")
	return nil
}

func (p *tasks) sendBack(graph protocol.TaskGraph, task protocol.Task, session, text, why string) error {
	if task.Tries >= protocol.AutoRetries {
		return p.taskFailed(graph, task, why)
	}
	if err := p.put(protocol.WithTask(graph, task.ID, func(n protocol.Task) protocol.Task {
		n.Tries++
		return n
	}), protocol.GraphActorSystem, why); err != nil {
		return err
	}
	p.sessions.Tell(session, text)
	return nil
}

// Judged by the farm, not by the step's session. Not verified: it is sent back, and the answer is false.
func (p *tasks) verified(graph protocol.TaskGraph, task protocol.Task, sessionID string) (ok bool, frozen []string, err error) {
	session := p.core.Session(sessionID)
	if session == nil || session.Worktree == nil {
		return true, nil, nil
	}
	cwd := *session.Worktree
	var changed []string
	if graph.Branch != nil && (protocol.IsAcceptance(task) || len(protocol.AcceptancesOf(graph, task)) > 0) {
		files, err := p.projects.ChangedFiles(cwd, *graph.Branch)
		if err != nil {
			return false, nil, p.taskFailed(graph, task, "看不出它改了哪些文件："+err.Error())
		}
		changed = files
	}
	if protocol.IsAcceptance(task) && task.Check != nil {
		if passed, _ := p.projects.Run(p.ctx, cwd, *task.Check); passed {
			return false, nil, p.sendBack(graph, task, sessionID, acceptancePassedText(*task.Check), "验收 "+*task.Check+" 现在就通过了")
		}
		return true, changed, nil
	}
	if touched := frozenTouched(graph, task, changed); len(touched) > 0 {
		return false, nil, p.sendBack(graph, task, sessionID, frozenTouchedText(touched), "改了冻结的验收："+strings.Join(touched, "、"))
	}
	var checks []string
	if task.Check != nil {
		checks = append(checks, *task.Check)
	}
	for _, check := range append(checks, protocol.AcceptanceChecks(graph, task)...) {
		if passed, output := p.projects.Run(p.ctx, cwd, check); !passed {
			return false, nil, p.sendBack(graph, task, sessionID, checkFailedText(check, output), "做完跑 "+check+" 没通过")
		}
	}
	return true, nil, nil
}

func (p *tasks) taskDone(graph protocol.TaskGraph, task protocol.Task, sessionID, conclusion string) error {
	session := p.core.Session(sessionID)
	ok, frozen, err := p.verified(graph, task, sessionID)
	if err != nil || !ok {
		return err
	}
	if graph.Branch == nil {
		return p.taskFailed(graph, task, "计划还没有分支")
	}
	commits, err := p.sessions.MergeInto(sessionID, *graph.Branch)
	if err != nil {
		var f project.MergeFailure
		if errors.As(err, &f) && f.Kind == "check" {
			return p.sendBack(graph, task, sessionID, f.Reason+"\n请修好检查，再交回来。", "项目检查没通过")
		}
		if errors.As(err, &f) && f.Kind == "conflict" {
			// It merges the task's branch into its own and resolves the conflict; then this runs again.
			return p.sendBack(graph, task, sessionID, protocol.ConflictBrief(f.Base, f.Files), "合进计划分支会冲突："+strings.Join(f.Files, "、"))
		}
		why := err.Error()
		if errors.As(err, &f) && f.Reason != "" {
			why = f.Reason
		}
		return p.taskFailed(graph, task, why)
	}
	next := protocol.WithTask(graph, task.ID, func(n protocol.Task) protocol.Task {
		n = taskUnmanned(n)
		n.State, n.Conclusion, n.Commits = protocol.TaskStateMerged, &conclusion, commits
		if protocol.IsAcceptance(n) {
			n.Frozen = frozen
		}
		if session != nil && session.Spent != nil {
			spent := *session.Spent
			n.Spent = &spent
		}
		return n
	})
	if allSettled(next) {
		next.State = protocol.GraphStateRipe
		next = taskWithNote(next, "")
	}
	if err := p.putFarm(next); err != nil {
		return fmt.Errorf("步骤「%s」已合进计划分支，但完成状态没能保存：%w", task.Title, err)
	}
	if next.State == protocol.GraphStateRipe {
		p.core.Notice(protocol.NoticeLevelInfo, "计划「"+next.Title+"」都做完了：在「计划」里看看改动，收获进主分支")
		p.tellManager(next.ID + "「" + next.Title + "」都做完了，等主人收获（graph_action merge）。用两三句话告诉主人做成了什么。\n" + protocol.GraphText(next))
	}
	return nil
}

func (p *tasks) taskEnded(graph protocol.TaskGraph, task protocol.Task, session protocol.Session, report protocol.FactReport) error {
	switch report.Outcome {
	case protocol.OutcomeCompleted:
		if err := p.taskDone(graph, task, session.ID, report.Summary); err != nil {
			return err
		}
	case protocol.OutcomeFailed:
		if err := p.sendBack(graph, task, session.ID, retryText(task), report.Summary); err != nil {
			return err
		}
	case protocol.OutcomeInterrupted:
		if graph.State != protocol.GraphStateRunning {
			return nil
		}
		graph.State = protocol.GraphStatePaused
		if err := p.putFarm(taskWithNote(graph, "「"+task.Title+"」被叫停了，计划先暂停；点继续接着做")); err != nil {
			return err
		}
	}
	return nil
}

func (p *tasks) follow(change core.Transition) {
	p.mu.Lock()
	defer p.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("vibevalley: a task step went wrong: %v", r)
		}
	}()
	switch f := change.Fact.Value.(type) {
	case protocol.FactReport:
		session := protocol.SessionOf(change.After, f.ID)
		if session == nil || session.Graph == nil {
			break
		}
		tag := *session.Graph
		graph := p.get(tag.ID)
		if graph == nil || !protocol.IsOpen(*graph) {
			break
		}
		if tag.Task == nil {
			if err := p.split(*graph, *session, f); err != nil {
				p.core.Notice(protocol.NoticeLevelWarn, err.Error())
				return
			}
		} else if task := protocol.TaskOf(*graph, *tag.Task); task != nil && taskStr(task.Session) == session.ID && task.State == protocol.TaskStateWorking {
			if err := p.taskEnded(*graph, *task, *session, f); err != nil {
				p.core.Notice(protocol.NoticeLevelWarn, err.Error())
				return
			}
		}
	case protocol.FactLeft:
		// Sent home from outside the task (a full farm, the person): its step did not get done.
		for _, graph := range protocol.GraphsOf(p.core.State()) {
			if !protocol.IsOpen(graph) {
				continue
			}
			if p.splitters[graph.ID] == f.ID && graph.State == protocol.GraphStateSplitting {
				if err := p.giveUp(graph, "规划的帮工被请走了"); err != nil {
					p.core.Notice(protocol.NoticeLevelWarn, err.Error())
					return
				}
			}
			i := slices.IndexFunc(graph.Tasks, func(n protocol.Task) bool {
				return taskStr(n.Session) == f.ID && n.State == protocol.TaskStateWorking
			})
			if i >= 0 {
				task := graph.Tasks[i]
				if err := p.taskFailed(protocol.WithTask(graph, task.ID, taskUnmanned), task, "帮工被请走了，这一步没做完"); err != nil {
					p.core.Notice(protocol.NoticeLevelWarn, err.Error())
					return
				}
			}
		}
	default:
		return
	}
	for _, graph := range protocol.GraphsOf(p.core.State()) {
		if graph.State == protocol.GraphStateRunning {
			if err := p.schedule(graph.ID); err != nil {
				p.core.Notice(protocol.NoticeLevelWarn, err.Error())
				return
			}
		}
	}
}

func (p *tasks) resumeWorking(id string) error {
	start := p.get(id)
	if start == nil {
		return nil
	}
	for _, task := range start.Tasks {
		if task.State != protocol.TaskStateWorking {
			continue
		}
		graph := p.get(id)
		if graph == nil {
			return nil
		}
		var session *protocol.Session
		if task.Session != nil {
			session = p.core.Session(*task.Session)
		}
		if session == nil {
			if err := p.putFarm(protocol.WithTask(*graph, task.ID, func(n protocol.Task) protocol.Task {
				n = taskUnmanned(n)
				n.State = protocol.TaskStateWaiting
				return n
			})); err != nil {
				return err
			}
			continue
		}
		if protocol.IsBusy(*session) {
			continue
		}
		if _, ripe := session.Phase.Value.(protocol.PhaseRipe); ripe {
			summary := "做完了"
			if session.LastRun != nil {
				summary = session.LastRun.Summary
			}
			if err := p.taskDone(*graph, task, session.ID, summary); err != nil {
				return err
			}
		} else {
			p.sessions.Tell(session.ID, "接着把这一步做完："+task.Title)
		}
	}
	return nil
}

func (p *tasks) Act(id string, action protocol.GraphAction, by protocol.GraphActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	graph, err := p.need(id)
	if err != nil {
		return "", err
	}
	not := func() (string, error) {
		return "", fmt.Errorf("计划「%s」%s，不能%s", graph.Title, protocol.GraphStateText[graph.State], protocol.GraphActionText[action])
	}
	switch action {
	case protocol.GraphActionStart:
		if graph.State != protocol.GraphStateDraft {
			return not()
		}
		if problems := protocol.GraphProblems(graph.Tasks); len(problems) > 0 {
			return "", errors.New(problems[0])
		}
		branch := "vibevalley/task-" + graph.ID + "-" + strconv.FormatInt(clock.NowMs(), 36)
		if err := p.projects.OpenBranch(graph.Project, branch); err != nil {
			return "", err
		}
		graph.State, graph.Branch = protocol.GraphStateRunning, &branch
		if err := p.put(taskWithNote(graph, ""), by, ""); err != nil {
			return "", fmt.Errorf("计划分支 %s 已创建，但开工状态没能保存：%w", branch, err)
		}
		if err := p.schedule(graph.ID); err != nil {
			return "", err
		}
		return "计划「" + graph.Title + "」开工了，分支 " + branch, nil
	case protocol.GraphActionPause:
		if graph.State != protocol.GraphStateRunning {
			return not()
		}
		graph.State = protocol.GraphStatePaused
		if err := p.put(taskWithNote(graph, "暂停了：正在做的做完，不开新的步骤"), by, ""); err != nil {
			return "", err
		}
		return "计划「" + graph.Title + "」暂停了：正在做的步骤做完，不再开新的", nil
	case protocol.GraphActionResume:
		if graph.State != protocol.GraphStatePaused {
			return not()
		}
		graph.State = protocol.GraphStateRunning
		if err := p.put(taskWithNote(graph, ""), by, ""); err != nil {
			return "", err
		}
		if err := p.resumeWorking(graph.ID); err != nil {
			return "", err
		}
		if err := p.schedule(graph.ID); err != nil {
			return "", err
		}
		return "计划「" + graph.Title + "」接着做了", nil
	case protocol.GraphActionAbandon:
		if !protocol.IsOpen(graph) {
			return not()
		}
		next := graph
		next.State = protocol.GraphStateAbandoned
		next.Tasks = make([]protocol.Task, len(graph.Tasks))
		for i, n := range graph.Tasks {
			if n.State == protocol.TaskStateWorking {
				n = taskUnmanned(n)
				n.State = protocol.TaskStateWaiting
			}
			next.Tasks[i] = n
		}
		note, said := "放弃了", "计划「"+graph.Title+"」放弃了"
		if graph.Branch != nil {
			note = "放弃了；分支 " + *graph.Branch + " 留着"
			said += "，分支 " + *graph.Branch + " 留着"
		}
		if err := p.put(taskWithNote(next, note), by, ""); err != nil {
			return "", err
		}
		splitter := p.splitters[graph.ID]
		delete(p.splitters, graph.ID)
		if splitter != "" {
			p.sessions.Dismiss(splitter)
		}
		for _, n := range graph.Tasks {
			if n.State == protocol.TaskStateWorking && n.Session != nil {
				p.sessions.Dismiss(*n.Session)
			}
		}
		return said, nil
	case protocol.GraphActionMerge:
		if graph.State != protocol.GraphStateRipe || graph.Branch == nil {
			return not()
		}
		merged, err := p.projects.MergeBranch(graph.Project, *graph.Branch)
		if err != nil {
			why := err.Error()
			var f project.MergeFailure
			if errors.As(err, &f) {
				if f.Kind == "conflict" {
					why = "合进 " + f.Base + " 会冲突（" + strings.Join(f.Files, "、") + "）：" + f.Base + " 在这期间变了"
				} else if f.Reason != "" {
					why = f.Reason
				}
			}
			if err := p.put(taskWithNote(graph, "没收进去："+why), by, ""); err != nil {
				return "", err
			}
			return "", errors.New("没收进去：" + why + "。计划分支 " + *graph.Branch + " 留着")
		}
		graph.State = protocol.GraphStateDone
		if err := p.put(taskWithNote(graph, ""), by, ""); err != nil {
			return "", fmt.Errorf("计划分支已合进主分支，但完成状态没能保存：%w", err)
		}
		p.core.Notice(protocol.NoticeLevelInfo, "收了计划「"+graph.Title+"」："+merged)
		return "收了计划「" + graph.Title + "」：" + merged, nil
	}
	return "", fmt.Errorf("不认识 %s 这个动作", action)
}

func (p *tasks) TaskAct(id, taskID string, action protocol.TaskAction, by protocol.GraphActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	graph, err := p.need(id)
	if err != nil {
		return "", err
	}
	found := protocol.TaskOf(graph, taskID)
	if found == nil {
		return "", fmt.Errorf("计划里没有「%s」这一步", taskID)
	}
	task := *found
	if graph.State != protocol.GraphStateRunning && graph.State != protocol.GraphStatePaused {
		return "", errors.New("计划" + protocol.GraphStateText[graph.State])
	}
	switch action {
	case protocol.TaskActionRetry:
		if task.State != protocol.TaskStateFailed {
			return "", errors.New("「" + task.Title + "」没有失败，不用重试")
		}
		var session *protocol.Session
		if task.Session != nil {
			session = p.core.Session(*task.Session)
		}
		if session != nil && !protocol.IsBusy(*session) {
			// Its session is still there: it goes on in the same session, with the (perhaps changed) job.
			if err := p.put(protocol.WithTask(graph, task.ID, func(n protocol.Task) protocol.Task {
				n.State, n.Tries = protocol.TaskStateWorking, 0
				return n
			}), by, ""); err != nil {
				return "", err
			}
			p.sessions.Tell(session.ID, retryText(task)+"\n\n这一步的工单：\n"+task.Brief)
			return session.Name + " 接着做「" + task.Title + "」", nil
		}
		if err := p.put(protocol.WithTask(graph, task.ID, func(n protocol.Task) protocol.Task {
			n = taskUnmanned(n)
			n.State, n.Tries = protocol.TaskStateWaiting, 0
			return n
		}), by, ""); err != nil {
			return "", err
		}
		if err := p.schedule(graph.ID); err != nil {
			return "", err
		}
		return "「" + task.Title + "」重新排上了", nil
	case protocol.TaskActionSkip:
		if task.State != protocol.TaskStateWaiting && task.State != protocol.TaskStateFailed {
			if task.State == protocol.TaskStateWorking {
				return "", errors.New("「" + task.Title + "」正在做，先叫停")
			}
			return "", errors.New("「" + task.Title + "」已经做完了")
		}
		next := protocol.WithTask(graph, task.ID, func(n protocol.Task) protocol.Task {
			n = taskUnmanned(n)
			n.State = protocol.TaskStateSkipped
			return n
		})
		if allSettled(next) {
			next.State = protocol.GraphStateRipe
			next = taskWithNote(next, "")
		}
		if err := p.put(next, by, ""); err != nil {
			return "", err
		}
		if task.Session != nil {
			p.sessions.Dismiss(*task.Session)
		}
		if err := p.schedule(graph.ID); err != nil {
			return "", err
		}
		return "跳过了「" + task.Title + "」，后面的步骤照常开工", nil
	}
	return "", fmt.Errorf("不认识 %s 这个动作", action)
}

func (p *tasks) edited(id string, change func(protocol.TaskGraph) editResult, by protocol.GraphActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	graph, err := p.need(id)
	if err != nil {
		return "", err
	}
	result := change(graph)
	if !result.OK {
		return "", errors.New(result.Problem)
	}
	if err := p.put(result.TaskGraph, by, ""); err != nil {
		return "", err
	}
	return "改好了", nil
}

func (p *tasks) EditTask(id, node string, edit protocol.TaskEdit, by protocol.GraphActor) (string, error) {
	return p.edited(id, func(graph protocol.TaskGraph) editResult { return editTask(graph, node, edit) }, by)
}

func (p *tasks) RemoveTask(id, node string, by protocol.GraphActor) (string, error) {
	return p.edited(id, func(graph protocol.TaskGraph) editResult { return removeTask(graph, node) }, by)
}

func (p *tasks) Events(id string) []protocol.GraphEvent {
	events := p.taskLog.List(id)
	graph := p.get(id)
	titleOf := func(node string) string {
		if graph != nil {
			if n := protocol.TaskOf(*graph, node); n != nil {
				return n.Title
			}
		}
		return node
	}
	for i := range events {
		events[i].Text = protocol.GraphEventText(changeOf(events[i]), titleOf)
		events[i].ActorText = protocol.ActorText[events[i].Actor]
	}
	return events
}

func (p *tasks) Changes(id string) (protocol.Changes, error) {
	graph, err := p.need(id)
	if err != nil {
		return protocol.Changes{}, err
	}
	if graph.Branch == nil {
		return protocol.Changes{}, errors.New("计划「" + graph.Title + "」还没开工，没有分支")
	}
	return p.projects.BranchChanges(graph.Project, *graph.Branch)
}

// The sessions, started before, have already marked the runs that stopped with the server.
func (p *tasks) OnStart(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ctx = ctx
	for _, graph := range protocol.GraphsOf(p.core.State()) {
		switch {
		case graph.State == protocol.GraphStateSplitting:
			graph.State = protocol.GraphStateAbandoned
			if err := p.putFarm(taskWithNote(graph, "VibeValley 重启了，规划停在了半路：再说一遍要做什么")); err != nil {
				return err
			}
			for _, h := range p.core.State().Sessions {
				if h.Graph != nil && h.Graph.ID == graph.ID && h.Graph.Task == nil {
					p.sessions.Dismiss(h.ID)
				}
			}
		case graph.State == protocol.GraphStateRunning &&
			slices.ContainsFunc(graph.Tasks, func(n protocol.Task) bool { return n.State == protocol.TaskStateWorking }):
			graph.State = protocol.GraphStatePaused
			if err := p.putFarm(taskWithNote(graph, "VibeValley 重启过，计划先暂停了；点继续接着做")); err != nil {
				return err
			}
		}
	}
	_, events, stop := p.core.Transitions()
	p.stop = stop
	for _, graph := range protocol.GraphsOf(p.core.State()) {
		if graph.State == protocol.GraphStateRunning {
			if err := p.schedule(graph.ID); err != nil {
				stop()
				p.stop = nil
				return err
			}
		}
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				switch event.Fact.Value.(type) {
				case protocol.FactReport, protocol.FactLeft:
					p.follow(event)
				}
			}
		}
	}()
	return nil
}

func (p *tasks) OnStop() {
	if p.stop != nil {
		p.stop()
	}
}
