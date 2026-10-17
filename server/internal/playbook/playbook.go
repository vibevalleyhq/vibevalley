package playbook

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

// Playbook sessions are followed through the core state's facts: a session's run ending is the cue. Everything here runs one at a time.

type planSessions interface {
	Hire(ctx context.Context, agent protocol.Agent, task, project string, opt session.HireOptions) session.Hired
	Tell(id, text string) string
	Dismiss(id string) bool
	Find(id string) *session.Roster
	MergeInto(id, target string) ([]string, error)
}

type planIssues interface {
	PutPlaybook(pb protocol.Playbook) error
	NextPlaybookID() (string, error)
}

type planProjects interface {
	Run(ctx context.Context, cwd, command string) (bool, string)
	OpenBranch(project, branch string) error
	MergeBranch(project, branch string) (string, error)
	BranchChanges(project, branch string) (protocol.Changes, error)
	ChangedFiles(cwd, base string) ([]string, error)
}

type playbooks struct {
	core        *core.Service
	issues      planIssues
	store       *agent.Service
	playbookLog *playbookLog
	runtimes    *runtime.Service
	// A step's run ending and the person pressing a button must not both read the same playbook and write over each other.
	mu           sync.Mutex
	planners     map[string]string
	plannerTries map[string]int
	news         *base.Hub[string]
	ctx          context.Context
	stop         func()

	sessions planSessions
	projects planProjects
	// nil: runtime.Check. Tests put their own.
	check func(protocol.Agent) []protocol.AgentIssue
}

type planWork struct {
	dispatch *issue.Service
	sessions *session.Service
	merges   *issue.Service
}

func (w planWork) Hire(ctx context.Context, agent protocol.Agent, task, project string, opt session.HireOptions) session.Hired {
	return w.dispatch.Hire(ctx, agent, task, project, opt)
}
func (w planWork) Tell(id, text string) string {
	return w.sessions.Tell(id, text, protocol.RunTrigger{Kind: protocol.RunTriggerKindPlaybook})
}
func (w planWork) Dismiss(id string) bool                        { return w.sessions.Dismiss(id) }
func (w planWork) Find(id string) *session.Roster                { return w.sessions.Find(id) }
func (w planWork) MergeInto(id, target string) ([]string, error) { return w.merges.Into(id, target) }

func newPlaybooks(core *core.Service, issues *issue.Service, store *agent.Service, log *playbookLog, sessions *session.Service, projects *project.Service, runtimes *runtime.Service) (*playbooks, error) {
	return &playbooks{
		core: core, issues: issues, store: store, playbookLog: log, runtimes: runtimes, sessions: planWork{issues, sessions, issues}, projects: projects,
		planners: map[string]string{}, plannerTries: map[string]int{}, news: base.NewHub[string](), ctx: context.Background(),
	}, nil
}

func (p *playbooks) issuesOf(a protocol.Agent) []protocol.AgentIssue {
	if p.check != nil {
		return p.check(a)
	}
	return p.runtimes.Check(p.ctx, a)
}

func (p *playbooks) News() *base.Hub[string] { return p.news }

func planWithNote(pb protocol.Playbook, note string) protocol.Playbook {
	pb.Note = nil
	if note != "" {
		pb.Note = &note
	}
	return pb
}

func planUnmanned(n protocol.PlaybookNode) protocol.PlaybookNode {
	n.Session = nil
	return n
}

func planStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (p *playbooks) candidates() []session.Candidate {
	var out []session.Candidate
	for _, a := range p.store.Agents() {
		usable := a.Enabled && !slices.ContainsFunc(p.issuesOf(a), func(i protocol.AgentIssue) bool {
			return i.Level == "error"
		})
		out = append(out, session.Candidate{Agent: a, Usable: usable})
	}
	return out
}

func (p *playbooks) get(id string) *protocol.Playbook {
	if pb := protocol.PlaybookOf(p.core.State(), id); pb != nil {
		c := *pb
		return &c
	}
	return nil
}

func (p *playbooks) need(id string) (protocol.Playbook, error) {
	if pb := p.get(id); pb != nil {
		return *pb, nil
	}
	return protocol.Playbook{}, fmt.Errorf("没有 %s 这个计划", id)
}

func (p *playbooks) put(pb protocol.Playbook, by protocol.PlaybookActor, why string) {
	before := p.get(pb.ID)
	if err := p.issues.PutPlaybook(pb); err != nil {
		log.Printf("vibevalley: playbook %s not kept: %v", pb.ID, err)
		return
	}
	p.playbookLog.Record(before, pb, by, why)
}

func (p *playbooks) putFarm(pb protocol.Playbook) { p.put(pb, protocol.PlaybookActorSystem, "") }

func (p *playbooks) tellManager(text string) { p.news.Publish("【种植计划】" + text) }

func (p *playbooks) giveUp(pb protocol.Playbook, why string) {
	planner := p.planners[pb.ID]
	delete(p.planners, pb.ID)
	pb.State = protocol.PlaybookStateAbandoned
	p.putFarm(planWithNote(pb, why))
	if planner != "" {
		p.sessions.Dismiss(planner)
	}
	p.core.Notice(protocol.NoticeLevelWarn, "计划「"+pb.Title+"」没拆成："+why)
	p.tellManager(pb.ID + "「" + pb.Title + "」没拆成：" + why + "。问主人要不要换个说法再拆。")
}

func (p *playbooks) Plan(goal, project, agent string, by protocol.PlaybookActor) (string, error) {
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
	id, err := p.issues.NextPlaybookID()
	if err != nil {
		return "", err
	}
	pb := protocol.Playbook{
		ID: id, Title: str.Clip(goal, 24), Goal: strings.TrimSpace(goal), Project: where,
		State: protocol.PlaybookStatePlanning, Nodes: []protocol.PlaybookNode{}, Parallel: protocol.DefaultParallel, CreatedAt: clock.NowMs(),
	}
	p.put(pb, by, "")
	var usable []protocol.Agent
	for _, c := range all {
		if c.Usable {
			usable = append(usable, c.Agent)
		}
	}
	worktree := true
	hired := p.sessions.Hire(p.ctx, *chosen, session.PlanningTask(goal, where, usable), where,
		session.HireOptions{Worktree: &worktree, Playbook: &protocol.SessionPlaybook{ID: pb.ID}, Issue: pb.ID, Trigger: &protocol.RunTrigger{Kind: protocol.RunTriggerKindPlaybook}})
	if hired.Session == nil {
		reason := hired.Refused
		if reason == "" {
			reason = "没派出去"
		}
		pb.State = protocol.PlaybookStateAbandoned
		p.put(planWithNote(pb, "规划的帮工派不出去："+reason), by, "")
		return "", errors.New(reason)
	}
	p.planners[pb.ID] = hired.Session.ID
	return fmt.Sprintf("%s 去看代码、拆计划了（%s）。拆好了会放在「计划」里，你看过再开工。", hired.Session.Name, pb.ID), nil
}

func (p *playbooks) planned(pb protocol.Playbook, session protocol.Session, report protocol.FactReport) {
	if pb.State != protocol.PlaybookStatePlanning {
		return
	}
	tries := p.plannerTries[pb.ID]
	switch report.Outcome {
	case protocol.OutcomeInterrupted:
		p.giveUp(pb, "规划被叫停了")
		return
	case protocol.OutcomeFailed:
		if tries >= 1 {
			p.giveUp(pb, "规划的帮工出错了："+report.Summary)
			return
		}
		p.plannerTries[pb.ID] = tries + 1
		p.sessions.Tell(session.ID, "上一轮没做成。看一下报错，接着把计划拆完，最后用 json 代码块给出。")
		return
	case protocol.OutcomeCompleted:
	}
	last := ""
	if r := p.sessions.Find(session.ID); r != nil {
		last = r.LastText
	}
	parsed := parsePlan(last)
	if !parsed.OK {
		if tries >= 1 {
			first := ""
			if len(parsed.Problems) > 0 {
				first = parsed.Problems[0]
			}
			p.giveUp(pb, "没给出能用的计划："+first)
			return
		}
		p.plannerTries[pb.ID] = tries + 1
		lines := make([]string, len(parsed.Problems))
		for i, x := range parsed.Problems {
			lines[i] = "- " + x
		}
		p.sessions.Tell(session.ID, "计划有问题：\n"+strings.Join(lines, "\n")+"\n\n改好，在最后用一个 json 代码块重新给出整张计划。")
		return
	}
	delete(p.planners, pb.ID)
	delete(p.plannerTries, pb.ID)
	draft := pb
	if parsed.Title != nil {
		draft.Title = *parsed.Title
	}
	draft.Nodes, draft.State = parsed.Nodes, protocol.PlaybookStateDraft
	draft = planWithNote(draft, "")
	p.putFarm(draft)
	p.sessions.Dismiss(session.ID)
	p.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("计划「%s」拆好了，%d 步：在「计划」里看过再开工", draft.Title, len(draft.Nodes)))
	p.tellManager(draft.ID + " 拆好了，等主人看过再开工（plan_action start）。用一两句话告诉主人拆成了哪几步。\n" + protocol.PlaybookText(draft))
}

func (p *playbooks) schedule(id string) {
	got := p.get(id)
	if got == nil || got.State != protocol.PlaybookStateRunning {
		return
	}
	pb := *got
	for _, node := range startable(pb) {
		agent := session.ChooseAgent(p.candidates(), node.Task, planStr(node.Agent), "")
		refused := "没有能派的帮工"
		var hired session.Hired
		if agent != nil {
			worktree := true
			nodeID := node.ID
			hired = p.sessions.Hire(p.ctx, *agent, nodeTask(pb, node), pb.Project, session.HireOptions{
				Worktree: &worktree, Playbook: &protocol.SessionPlaybook{ID: pb.ID, Node: &nodeID}, Base: planStr(pb.Branch), Trigger: &protocol.RunTrigger{Kind: protocol.RunTriggerKindPlaybook},
				Issue: protocol.StepIssueID(pb.ID, node.ID),
			})
			refused = hired.Refused
		}
		if hired.Session == nil {
			// Not now: it waits, and is tried again when a session finishes or leaves.
			note := "「" + node.Title + "」先等着：" + refused
			if planStr(pb.Note) != note {
				p.putFarm(planWithNote(pb, note))
			}
			return
		}
		session := hired.Session.ID
		pb = protocol.WithNode(planWithNote(pb, ""), node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
			n.State, n.Session, n.Tries = protocol.NodeStateWorking, &session, 0
			return n
		})
		p.putFarm(pb)
	}
}

func (p *playbooks) stepFailed(pb protocol.Playbook, node protocol.PlaybookNode, why string) {
	p.putFarm(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
		n.State, n.Conclusion = protocol.NodeStateFailed, &why
		n.Failures++
		return n
	}))
	p.core.Notice(protocol.NoticeLevelWarn, "计划「"+pb.Title+"」的「"+node.Title+"」没做成："+why)
	p.tellManager(pb.ID + " 的「" + node.Title + "」（" + node.ID + "）没做成：" + why +
		"。它后面的步骤在等；问主人是重试（node_action retry）、改工单，还是跳过（node_action skip）。")
}

func (p *playbooks) sendBack(pb protocol.Playbook, node protocol.PlaybookNode, session, text, why string) {
	if node.Tries >= protocol.AutoRetries {
		p.stepFailed(pb, node, why)
		return
	}
	p.put(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
		n.Tries++
		return n
	}), protocol.PlaybookActorSystem, why)
	p.sessions.Tell(session, text)
}

// Judged by the farm, not by the step's session. Not verified: it is sent back, and the answer is false.
func (p *playbooks) verified(pb protocol.Playbook, node protocol.PlaybookNode, sessionID string) (ok bool, frozen []string) {
	session := p.core.Session(sessionID)
	if session == nil || session.Worktree == nil {
		return true, nil
	}
	cwd := *session.Worktree
	var changed []string
	if pb.Branch != nil && (protocol.IsAcceptance(node) || len(protocol.AcceptancesOf(pb, node)) > 0) {
		files, err := p.projects.ChangedFiles(cwd, *pb.Branch)
		if err != nil {
			p.stepFailed(pb, node, "看不出它改了哪些文件："+err.Error())
			return false, nil
		}
		changed = files
	}
	if protocol.IsAcceptance(node) && node.Check != nil {
		if passed, _ := p.projects.Run(p.ctx, cwd, *node.Check); passed {
			p.sendBack(pb, node, sessionID, acceptancePassedText(*node.Check), "验收 "+*node.Check+" 现在就通过了")
			return false, nil
		}
		return true, changed
	}
	if touched := frozenTouched(pb, node, changed); len(touched) > 0 {
		p.sendBack(pb, node, sessionID, frozenTouchedText(touched), "改了冻结的验收："+strings.Join(touched, "、"))
		return false, nil
	}
	var checks []string
	if node.Check != nil {
		checks = append(checks, *node.Check)
	}
	for _, check := range append(checks, protocol.AcceptanceChecks(pb, node)...) {
		if passed, output := p.projects.Run(p.ctx, cwd, check); !passed {
			p.sendBack(pb, node, sessionID, checkFailedText(check, output), "做完跑 "+check+" 没通过")
			return false, nil
		}
	}
	return true, nil
}

func (p *playbooks) stepDone(pb protocol.Playbook, node protocol.PlaybookNode, sessionID, conclusion string) {
	session := p.core.Session(sessionID)
	ok, frozen := p.verified(pb, node, sessionID)
	if !ok {
		return
	}
	if pb.Branch == nil {
		p.stepFailed(pb, node, "计划还没有分支")
		return
	}
	commits, err := p.sessions.MergeInto(sessionID, *pb.Branch)
	if err != nil {
		var f project.MergeFailure
		if errors.As(err, &f) && f.Kind == "conflict" {
			// It merges the playbook's branch into its own and resolves the conflict; then this runs again.
			p.sendBack(pb, node, sessionID, protocol.ConflictTask(f.Base, f.Files), "合进计划分支会冲突："+strings.Join(f.Files, "、"))
			return
		}
		why := err.Error()
		if errors.As(err, &f) && f.Reason != "" {
			why = f.Reason
		}
		p.stepFailed(pb, node, why)
		return
	}
	next := protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
		n = planUnmanned(n)
		n.State, n.Conclusion, n.Commits = protocol.NodeStateMerged, &conclusion, commits
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
		next.State = protocol.PlaybookStateRipe
		next = planWithNote(next, "")
	}
	p.putFarm(next)
	if next.State == protocol.PlaybookStateRipe {
		p.core.Notice(protocol.NoticeLevelInfo, "计划「"+next.Title+"」都做完了：在「计划」里看看改动，收获进主分支")
		p.tellManager(next.ID + "「" + next.Title + "」都做完了，等主人收获（plan_action merge）。用两三句话告诉主人做成了什么。\n" + protocol.PlaybookText(next))
	}
}

func (p *playbooks) stepEnded(pb protocol.Playbook, node protocol.PlaybookNode, session protocol.Session, report protocol.FactReport) {
	switch report.Outcome {
	case protocol.OutcomeCompleted:
		p.stepDone(pb, node, session.ID, report.Summary)
	case protocol.OutcomeFailed:
		p.sendBack(pb, node, session.ID, retryText(node), report.Summary)
	case protocol.OutcomeInterrupted:
		if pb.State != protocol.PlaybookStateRunning {
			return
		}
		pb.State = protocol.PlaybookStatePaused
		p.putFarm(planWithNote(pb, "「"+node.Title+"」被叫停了，计划先暂停；点继续接着做"))
	}
}

func (p *playbooks) follow(fact protocol.FactValue) {
	p.mu.Lock()
	defer p.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("vibevalley: a playbook step went wrong: %v", r)
		}
	}()
	switch f := fact.(type) {
	case protocol.FactReport:
		session := p.core.Session(f.ID)
		if session == nil || session.Playbook == nil {
			break
		}
		tag := *session.Playbook
		pb := p.get(tag.ID)
		if pb == nil || !protocol.IsOpen(*pb) {
			break
		}
		if tag.Node == nil {
			p.planned(*pb, *session, f)
		} else if node := protocol.NodeOf(*pb, *tag.Node); node != nil && planStr(node.Session) == session.ID && node.State == protocol.NodeStateWorking {
			p.stepEnded(*pb, *node, *session, f)
		}
	case protocol.FactLeft:
		// Sent home from outside the playbook (a full farm, the person): its step did not get done.
		for _, pb := range protocol.PlaybooksOf(p.core.State()) {
			if !protocol.IsOpen(pb) {
				continue
			}
			if p.planners[pb.ID] == f.ID && pb.State == protocol.PlaybookStatePlanning {
				p.giveUp(pb, "规划的帮工被请走了")
			}
			i := slices.IndexFunc(pb.Nodes, func(n protocol.PlaybookNode) bool {
				return planStr(n.Session) == f.ID && n.State == protocol.NodeStateWorking
			})
			if i >= 0 {
				node := pb.Nodes[i]
				p.stepFailed(protocol.WithNode(pb, node.ID, planUnmanned), node, "帮工被请走了，这一步没做完")
			}
		}
	default:
		return
	}
	for _, pb := range protocol.PlaybooksOf(p.core.State()) {
		if pb.State == protocol.PlaybookStateRunning {
			p.schedule(pb.ID)
		}
	}
}

func (p *playbooks) resumeWorking(id string) {
	start := p.get(id)
	if start == nil {
		return
	}
	for _, node := range start.Nodes {
		if node.State != protocol.NodeStateWorking {
			continue
		}
		pb := p.get(id)
		if pb == nil {
			return
		}
		var session *protocol.Session
		if node.Session != nil {
			session = p.core.Session(*node.Session)
		}
		if session == nil {
			p.putFarm(protocol.WithNode(*pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
				n = planUnmanned(n)
				n.State = protocol.NodeStateWaiting
				return n
			}))
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
			p.stepDone(*pb, node, session.ID, summary)
		} else {
			p.sessions.Tell(session.ID, "接着把这一步做完："+node.Title)
		}
	}
}

var planActionText = map[protocol.PlaybookAction]string{
	protocol.PlaybookActionStart: "开工", protocol.PlaybookActionPause: "暂停", protocol.PlaybookActionResume: "继续",
	protocol.PlaybookActionAbandon: "放弃", protocol.PlaybookActionMerge: "收获",
}

func (p *playbooks) Act(id string, action protocol.PlaybookAction, by protocol.PlaybookActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pb, err := p.need(id)
	if err != nil {
		return "", err
	}
	not := func() (string, error) {
		return "", fmt.Errorf("计划「%s」%s，不能%s", pb.Title, protocol.PlaybookStateText[pb.State], planActionText[action])
	}
	switch action {
	case protocol.PlaybookActionStart:
		if pb.State != protocol.PlaybookStateDraft {
			return not()
		}
		if problems := protocol.PlanProblems(pb.Nodes); len(problems) > 0 {
			return "", errors.New(problems[0])
		}
		branch := "vibevalley/pb-" + pb.ID + "-" + strconv.FormatInt(clock.NowMs(), 36)
		if err := p.projects.OpenBranch(pb.Project, branch); err != nil {
			return "", err
		}
		pb.State, pb.Branch = protocol.PlaybookStateRunning, &branch
		p.put(planWithNote(pb, ""), by, "")
		p.schedule(pb.ID)
		return "计划「" + pb.Title + "」开工了，分支 " + branch, nil
	case protocol.PlaybookActionPause:
		if pb.State != protocol.PlaybookStateRunning {
			return not()
		}
		pb.State = protocol.PlaybookStatePaused
		p.put(planWithNote(pb, "暂停了：正在做的做完，不开新的步骤"), by, "")
		return "计划「" + pb.Title + "」暂停了：正在做的步骤做完，不再开新的", nil
	case protocol.PlaybookActionResume:
		if pb.State != protocol.PlaybookStatePaused {
			return not()
		}
		pb.State = protocol.PlaybookStateRunning
		p.put(planWithNote(pb, ""), by, "")
		p.resumeWorking(pb.ID)
		p.schedule(pb.ID)
		return "计划「" + pb.Title + "」接着做了", nil
	case protocol.PlaybookActionAbandon:
		if !protocol.IsOpen(pb) {
			return not()
		}
		planner := p.planners[pb.ID]
		delete(p.planners, pb.ID)
		if planner != "" {
			p.sessions.Dismiss(planner)
		}
		for _, n := range pb.Nodes {
			if n.State == protocol.NodeStateWorking && n.Session != nil {
				p.sessions.Dismiss(*n.Session)
			}
		}
		next := pb
		next.State = protocol.PlaybookStateAbandoned
		next.Nodes = make([]protocol.PlaybookNode, len(pb.Nodes))
		for i, n := range pb.Nodes {
			if n.State == protocol.NodeStateWorking {
				n = planUnmanned(n)
				n.State = protocol.NodeStateWaiting
			}
			next.Nodes[i] = n
		}
		note, said := "放弃了", "计划「"+pb.Title+"」放弃了"
		if pb.Branch != nil {
			note = "放弃了；分支 " + *pb.Branch + " 留着"
			said += "，分支 " + *pb.Branch + " 留着"
		}
		p.put(planWithNote(next, note), by, "")
		return said, nil
	case protocol.PlaybookActionMerge:
		if pb.State != protocol.PlaybookStateRipe || pb.Branch == nil {
			return not()
		}
		merged, err := p.projects.MergeBranch(pb.Project, *pb.Branch)
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
			p.put(planWithNote(pb, "没收进去："+why), by, "")
			return "", errors.New("没收进去：" + why + "。计划分支 " + *pb.Branch + " 留着")
		}
		pb.State = protocol.PlaybookStateDone
		p.put(planWithNote(pb, ""), by, "")
		p.core.Notice(protocol.NoticeLevelInfo, "收了计划「"+pb.Title+"」："+merged)
		return "收了计划「" + pb.Title + "」：" + merged, nil
	}
	return "", fmt.Errorf("不认识 %s 这个动作", action)
}

func (p *playbooks) NodeAct(id, nodeID string, action protocol.NodeAction, by protocol.PlaybookActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pb, err := p.need(id)
	if err != nil {
		return "", err
	}
	found := protocol.NodeOf(pb, nodeID)
	if found == nil {
		return "", fmt.Errorf("计划里没有「%s」这一步", nodeID)
	}
	node := *found
	if pb.State != protocol.PlaybookStateRunning && pb.State != protocol.PlaybookStatePaused {
		return "", errors.New("计划" + protocol.PlaybookStateText[pb.State])
	}
	switch action {
	case protocol.NodeActionRetry:
		if node.State != protocol.NodeStateFailed {
			return "", errors.New("「" + node.Title + "」没有失败，不用重试")
		}
		var session *protocol.Session
		if node.Session != nil {
			session = p.core.Session(*node.Session)
		}
		if session != nil && !protocol.IsBusy(*session) {
			// Its session is still there: it goes on in the same session, with the (perhaps changed) job.
			p.put(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
				n.State, n.Tries = protocol.NodeStateWorking, 0
				return n
			}), by, "")
			p.sessions.Tell(session.ID, retryText(node)+"\n\n这一步的工单：\n"+node.Task)
			return session.Name + " 接着做「" + node.Title + "」", nil
		}
		p.put(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
			n = planUnmanned(n)
			n.State, n.Tries = protocol.NodeStateWaiting, 0
			return n
		}), by, "")
		p.schedule(pb.ID)
		return "「" + node.Title + "」重新排上了", nil
	case protocol.NodeActionSkip:
		if node.State != protocol.NodeStateWaiting && node.State != protocol.NodeStateFailed {
			if node.State == protocol.NodeStateWorking {
				return "", errors.New("「" + node.Title + "」正在做，先叫停")
			}
			return "", errors.New("「" + node.Title + "」已经做完了")
		}
		if node.Session != nil {
			p.sessions.Dismiss(*node.Session)
		}
		next := protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
			n = planUnmanned(n)
			n.State = protocol.NodeStateSkipped
			return n
		})
		if allSettled(next) {
			next.State = protocol.PlaybookStateRipe
			next = planWithNote(next, "")
		}
		p.put(next, by, "")
		p.schedule(pb.ID)
		return "跳过了「" + node.Title + "」，后面的步骤照常开工", nil
	}
	return "", fmt.Errorf("不认识 %s 这个动作", action)
}

func (p *playbooks) edited(id string, change func(protocol.Playbook) editResult, by protocol.PlaybookActor) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	pb, err := p.need(id)
	if err != nil {
		return "", err
	}
	result := change(pb)
	if !result.OK {
		return "", errors.New(result.Problem)
	}
	p.put(result.Playbook, by, "")
	return "改好了", nil
}

func (p *playbooks) EditNode(id, node string, edit protocol.NodeEdit, by protocol.PlaybookActor) (string, error) {
	return p.edited(id, func(pb protocol.Playbook) editResult { return editNode(pb, node, edit) }, by)
}

func (p *playbooks) RemoveNode(id, node string, by protocol.PlaybookActor) (string, error) {
	return p.edited(id, func(pb protocol.Playbook) editResult { return removeNode(pb, node) }, by)
}

func (p *playbooks) Events(id string) []protocol.PlaybookEvent {
	events := p.playbookLog.List(id)
	pb := p.get(id)
	titleOf := func(node string) string {
		if pb != nil {
			if n := protocol.NodeOf(*pb, node); n != nil {
				return n.Title
			}
		}
		return node
	}
	for i := range events {
		events[i].Text = protocol.PlaybookEventText(changeOf(events[i]), titleOf)
		events[i].ActorText = protocol.ActorText[events[i].Actor]
	}
	return events
}

func (p *playbooks) Changes(id string) (protocol.Changes, error) {
	pb, err := p.need(id)
	if err != nil {
		return protocol.Changes{}, err
	}
	if pb.Branch == nil {
		return protocol.Changes{}, errors.New("计划「" + pb.Title + "」还没开工，没有分支")
	}
	return p.projects.BranchChanges(pb.Project, *pb.Branch)
}

// The sessions, started before, have already marked the runs that stopped with the server.
func (p *playbooks) OnStart(ctx context.Context) error {
	p.mu.Lock()
	p.ctx = ctx
	for _, pb := range protocol.PlaybooksOf(p.core.State()) {
		switch {
		case pb.State == protocol.PlaybookStatePlanning:
			pb.State = protocol.PlaybookStateAbandoned
			p.putFarm(planWithNote(pb, "VibeValley 重启了，规划停在了半路：再说一遍要做什么"))
			for _, h := range p.core.State().Sessions {
				if h.Playbook != nil && h.Playbook.ID == pb.ID && h.Playbook.Node == nil {
					p.sessions.Dismiss(h.ID)
				}
			}
		case pb.State == protocol.PlaybookStateRunning &&
			slices.ContainsFunc(pb.Nodes, func(n protocol.PlaybookNode) bool { return n.State == protocol.NodeStateWorking }):
			pb.State = protocol.PlaybookStatePaused
			p.putFarm(planWithNote(pb, "VibeValley 重启过，计划先暂停了；点继续接着做"))
		}
	}
	_, events, stop := p.core.Events()
	p.stop = stop
	for _, pb := range protocol.PlaybooksOf(p.core.State()) {
		if pb.State == protocol.PlaybookStateRunning {
			p.schedule(pb.ID)
		}
	}
	p.mu.Unlock()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-events:
				if !ok {
					return
				}
				switch fact := event.Value.(type) {
				case protocol.FactReport, protocol.FactLeft:
					p.follow(fact.(protocol.FactValue))
				}
			}
		}
	}()
	return nil
}

func (p *playbooks) OnStop() {
	if p.stop != nil {
		p.stop()
	}
}
