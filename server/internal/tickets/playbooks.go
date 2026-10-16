package tickets

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strconv"
	"strings"
	"sync"

	"vibevalley/internal/base"
	"vibevalley/internal/projects"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

// Playbooks (种植计划) (ported from the TypeScript server's playbooks.ts, removed): a long job split into steps, each step a helper's job on its own
// branch off the playbook's branch, merged back once it is done. A playbook is a parent issue with a plan, its steps
// the sub-issues (Issues.PutPlaybook writes them, protocol.PlaybookOf reads them back from the core state); the rules
// are protocol's (playbook.go). The planner is a run of the parent issue, a step's helper a run of its sub-issue. This service plans them (a helper reads the code and
// splits the job), runs them (steps whose needs are merged go to helpers, within the limits), merges finished steps,
// and harvests the whole playbook into the main branch when the person says so. It follows the helpers through the
// site's facts: a playbook helper's turn ending is its cue. Everything it does runs one at a time.
// Rationale: .agents/notes/implemented/feature/2026-10-11-playbooks.md.

// planCrew is what playbooks ask of the crew: Crew on the farm, a script in tests.
type planCrew interface {
	Hire(ctx context.Context, agent protocol.AgentProfile, task, project string, opt base.HireOptions) base.Hired
	Tell(id, text string) string
	Dismiss(id string) bool
	Find(id string) *base.Roster
	HarvestInto(id, target string) ([]string, error)
}

// planIssues is where playbooks are kept: Issues on the farm.
type planIssues interface {
	PutPlaybook(pb protocol.Playbook) error
	NextPlaybookID() (string, error)
}

// planProjects is what playbooks ask of the projects: Projects on the farm, a script in tests.
type planProjects interface {
	Run(ctx context.Context, cwd, command string) (bool, string)
	OpenBranch(project, branch string) error
	HarvestBranch(project, branch string) (string, error)
	BranchChanges(project, branch string) (protocol.Changes, error)
	ChangedFiles(cwd, base string) ([]string, error)
}

type Playbooks struct {
	site        *base.Site
	issues      planIssues
	store       *base.Store
	playbookLog *PlaybookLog
	runtimes    *runs.Runtimes
	// mu: one change to the playbooks at a time. A step's turn ending and the person pressing a button must not both
	// read the same playbook and write over each other.
	mu sync.Mutex
	// planners is the helper planning each playbook, while it plans; plannerTries the times one was sent back for a
	// plan that did not hold together.
	planners     map[string]string
	plannerTries map[string]int
	news         *base.Hub[string]
	ctx          context.Context
	stop         func()

	// crew and projects are the farm's Crew and Projects, a script in tests; runtime is the runtimes' Info unless a
	// test gives its own.
	crew     planCrew
	projects planProjects
	runtime  func(id string) *protocol.RuntimeInfo
}

// planWork is planCrew on the farm: helpers sent out by Dispatch, told and sent home by the Crew, their branches merged
// into the playbook's by Merges.
type planWork struct {
	dispatch *Dispatch
	crew     *runs.Crew
	merges   *Merges
}

func (w planWork) Hire(ctx context.Context, agent protocol.AgentProfile, task, project string, opt base.HireOptions) base.Hired {
	return w.dispatch.Hire(ctx, agent, task, project, opt)
}
func (w planWork) Tell(id, text string) string                     { return w.crew.Tell(id, text) }
func (w planWork) Dismiss(id string) bool                          { return w.crew.Dismiss(id) }
func (w planWork) Find(id string) *base.Roster                     { return w.crew.Find(id) }
func (w planWork) HarvestInto(id, target string) ([]string, error) { return w.merges.Into(id, target) }

func newPlaybooks(site *base.Site, issues *Issues, store *base.Store, log *PlaybookLog, crew *runs.Crew, dispatch *Dispatch, merges *Merges, projects *projects.Projects, runtimes *runs.Runtimes) (*Playbooks, error) {
	return &Playbooks{
		site: site, issues: issues, store: store, playbookLog: log, runtimes: runtimes, crew: planWork{dispatch, crew, merges}, projects: projects,
		planners: map[string]string{}, plannerTries: map[string]int{}, news: base.NewHub[string](), ctx: context.Background(),
	}, nil
}

func (p *Playbooks) runtimeInfo(id string) *protocol.RuntimeInfo {
	if p.runtime != nil {
		return p.runtime(id)
	}
	return p.runtimes.Info(p.ctx, id)
}

// News is what playbooks did that the manager should hear, in a line each: a plan is ready, a step failed, a
// playbook is ripe.
func (p *Playbooks) News() *base.Hub[string] { return p.news }

// ── Small things ─────────────────────────────────────────────────────────────

// planWithNote is the playbook without a note, or with this one.
func planWithNote(pb protocol.Playbook, note string) protocol.Playbook {
	pb.Note = nil
	if note != "" {
		pb.Note = &note
	}
	return pb
}

// planUnmanned is a step no helper is on any more.
func planUnmanned(n protocol.PlaybookNode) protocol.PlaybookNode {
	n.Helper = nil
	return n
}

func planStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (p *Playbooks) candidates() []runs.Candidate {
	var out []runs.Candidate
	for _, a := range p.store.Agents() {
		usable := a.Enabled && !slices.ContainsFunc(protocol.AgentIssues(a, p.runtimeInfo(a.Runtime)), func(i protocol.AgentIssue) bool {
			return i.Level == "error"
		})
		out = append(out, runs.Candidate{Agent: a, Usable: usable})
	}
	return out
}

func (p *Playbooks) get(id string) *protocol.Playbook {
	if pb := protocol.PlaybookOf(p.site.State(), id); pb != nil {
		c := *pb
		return &c
	}
	return nil
}

func (p *Playbooks) need(id string) (protocol.Playbook, error) {
	if pb := p.get(id); pb != nil {
		return *pb, nil
	}
	return protocol.Playbook{}, fmt.Errorf("没有 %s 这个计划", id)
}

// put writes a playbook, and keeps what changed in its history: done by by, for why when the change does not say.
func (p *Playbooks) put(pb protocol.Playbook, by protocol.PlaybookActor, why string) {
	before := p.get(pb.ID)
	if err := p.issues.PutPlaybook(pb); err != nil {
		log.Printf("vibevalley: playbook %s not kept: %v", pb.ID, err)
		return
	}
	p.playbookLog.Record(before, pb, by, why)
}

// putFarm is a write the farm itself does.
func (p *Playbooks) putFarm(pb protocol.Playbook) { p.put(pb, protocol.PlaybookActorFarm, "") }

func (p *Playbooks) tellManager(text string) { p.news.Publish("【种植计划】" + text) }

// ── Planning ─────────────────────────────────────────────────────────────────

func (p *Playbooks) giveUp(pb protocol.Playbook, why string) {
	planner := p.planners[pb.ID]
	delete(p.planners, pb.ID)
	pb.State = protocol.PlaybookStateAbandoned
	p.putFarm(planWithNote(pb, why))
	if planner != "" {
		p.crew.Dismiss(planner)
	}
	p.site.Notice(protocol.NoticeLevelWarn, "计划「"+pb.Title+"」没拆成："+why)
	p.tellManager(pb.ID + "「" + pb.Title + "」没拆成：" + why + "。问主人要不要换个说法再拆。")
}

// Plan has a helper split goal into a playbook for project; it waits as a draft for the person to look over.
func (p *Playbooks) Plan(goal, project, agent string, by protocol.PlaybookActor) (string, error) {
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
	chosen := runs.ChooseAgent(all, "规划 计划 拆分 "+goal, agent, "")
	if chosen == nil {
		return "", errors.New("没有能派的帮工来拆计划")
	}
	id, err := p.issues.NextPlaybookID()
	if err != nil {
		return "", err
	}
	pb := protocol.Playbook{
		ID: id, Title: base.ClipLine(goal, 24), Goal: strings.TrimSpace(goal), Project: where,
		State: protocol.PlaybookStatePlanning, Nodes: []protocol.PlaybookNode{}, Parallel: protocol.DefaultParallel, CreatedAt: base.NowMs(),
	}
	p.put(pb, by, "")
	var usable []protocol.AgentProfile
	for _, c := range all {
		if c.Usable {
			usable = append(usable, c.Agent)
		}
	}
	worktree := true
	hired := p.crew.Hire(p.ctx, *chosen, runs.PlanningTask(goal, where, usable), where,
		base.HireOptions{Worktree: &worktree, Playbook: &protocol.HelperPlaybook{ID: pb.ID}, Issue: pb.ID})
	if hired.Helper == nil {
		reason := hired.Refused
		if reason == "" {
			reason = "没派出去"
		}
		pb.State = protocol.PlaybookStateAbandoned
		p.put(planWithNote(pb, "规划的帮工派不出去："+reason), by, "")
		return "", errors.New(reason)
	}
	p.planners[pb.ID] = hired.Helper.ID
	return fmt.Sprintf("%s 去看代码、拆计划了（%s）。拆好了会放在「计划」里，你看过再开工。", hired.Helper.Name, pb.ID), nil
}

// planned: the planner's turn ended. Its plan becomes a draft, or it is sent back once, or planning is given up.
func (p *Playbooks) planned(pb protocol.Playbook, helper protocol.Helper, report protocol.FactReport) {
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
		p.crew.Tell(helper.ID, "上一轮没做成。看一下报错，接着把计划拆完，最后用 json 代码块给出。")
		return
	case protocol.OutcomeCompleted:
	}
	last := ""
	if r := p.crew.Find(helper.ID); r != nil {
		last = r.LastText
	}
	parsed := protocol.ParsePlan(last)
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
		p.crew.Tell(helper.ID, "计划有问题：\n"+strings.Join(lines, "\n")+"\n\n改好，在最后用一个 json 代码块重新给出整张计划。")
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
	p.crew.Dismiss(helper.ID)
	p.site.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("计划「%s」拆好了，%d 步：在「计划」里看过再开工", draft.Title, len(draft.Nodes)))
	p.tellManager(draft.ID + " 拆好了，等主人看过再开工（plan_action start）。用一两句话告诉主人拆成了哪几步。\n" + protocol.PlaybookText(draft))
}

// ── Running ──────────────────────────────────────────────────────────────────

// schedule sends the steps whose needs are in to helpers, as many as the playbook and the farm allow.
func (p *Playbooks) schedule(id string) {
	got := p.get(id)
	if got == nil || got.State != protocol.PlaybookStateRunning {
		return
	}
	pb := *got
	for _, node := range protocol.Startable(pb) {
		agent := runs.ChooseAgent(p.candidates(), node.Task, planStr(node.Agent), "")
		refused := "没有能派的帮工"
		var hired base.Hired
		if agent != nil {
			worktree := true
			nodeID := node.ID
			hired = p.crew.Hire(p.ctx, *agent, protocol.NodeTask(pb, node), pb.Project, base.HireOptions{
				Worktree: &worktree, Playbook: &protocol.HelperPlaybook{ID: pb.ID, Node: &nodeID}, Base: planStr(pb.Branch),
				Issue: protocol.StepIssueID(pb.ID, node.ID),
			})
			refused = hired.Refused
		}
		if hired.Helper == nil {
			// Not now: it waits, and is tried again when a helper finishes or leaves.
			note := "「" + node.Title + "」先等着：" + refused
			if planStr(pb.Note) != note {
				p.putFarm(planWithNote(pb, note))
			}
			return
		}
		helper := hired.Helper.ID
		pb = protocol.WithNode(planWithNote(pb, ""), node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
			n.State, n.Helper, n.Tries = protocol.NodeStateWorking, &helper, 0
			return n
		})
		p.putFarm(pb)
	}
}

func (p *Playbooks) stepFailed(pb protocol.Playbook, node protocol.PlaybookNode, why string) {
	p.putFarm(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
		n.State, n.Conclusion = protocol.NodeStateFailed, &why
		n.Failures++
		return n
	}))
	p.site.Notice(protocol.NoticeLevelWarn, "计划「"+pb.Title+"」的「"+node.Title+"」没做成："+why)
	p.tellManager(pb.ID + " 的「" + node.Title + "」（" + node.ID + "）没做成：" + why +
		"。它后面的步骤在等；问主人是重试（node_action retry）、改工单，还是跳过（node_action skip）。")
}

// sendBack sends a step back to its helper, if it has not been sent back too often by now.
func (p *Playbooks) sendBack(pb protocol.Playbook, node protocol.PlaybookNode, helper, text, why string) {
	if node.Tries >= protocol.AutoRetries {
		p.stepFailed(pb, node, why)
		return
	}
	p.put(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
		n.Tries++
		return n
	}), protocol.PlaybookActorFarm, why)
	p.crew.Tell(helper, text)
}

// verified is whether a finished step holds up, judged by the farm and not by its helper: an acceptance step's check
// fails (it caught something) and what it left is frozen; any other step leaves the frozen files alone and passes its
// own check, and a last step the acceptance checks before it. Not: it is sent back, and the answer is false. frozen is
// what an acceptance step leaves.
func (p *Playbooks) verified(pb protocol.Playbook, node protocol.PlaybookNode, helperID string) (ok bool, frozen []string) {
	helper := p.site.Helper(helperID)
	if helper == nil || helper.Worktree == nil {
		return true, nil
	}
	cwd := *helper.Worktree
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
			p.sendBack(pb, node, helperID, protocol.AcceptancePassedText(*node.Check), "验收 "+*node.Check+" 现在就通过了")
			return false, nil
		}
		return true, changed
	}
	if touched := protocol.FrozenTouched(pb, node, changed); len(touched) > 0 {
		p.sendBack(pb, node, helperID, protocol.FrozenTouchedText(touched), "改了冻结的验收："+strings.Join(touched, "、"))
		return false, nil
	}
	var checks []string
	if node.Check != nil {
		checks = append(checks, *node.Check)
	}
	for _, check := range append(checks, protocol.AcceptanceChecks(pb, node)...) {
		if passed, output := p.projects.Run(p.ctx, cwd, check); !passed {
			p.sendBack(pb, node, helperID, protocol.CheckFailedText(check, output), "做完跑 "+check+" 没通过")
			return false, nil
		}
	}
	return true, nil
}

// stepDone: a step's helper finished. Its checks, then its branch merged into the playbook's.
func (p *Playbooks) stepDone(pb protocol.Playbook, node protocol.PlaybookNode, helperID, conclusion string) {
	helper := p.site.Helper(helperID)
	ok, frozen := p.verified(pb, node, helperID)
	if !ok {
		return
	}
	if pb.Branch == nil {
		p.stepFailed(pb, node, "计划还没有分支")
		return
	}
	commits, err := p.crew.HarvestInto(helperID, *pb.Branch)
	if err != nil {
		var f base.HarvestFailure
		if errors.As(err, &f) && f.Kind == "conflict" {
			// It merges the playbook's branch into its own and resolves the conflict; then this runs again.
			p.sendBack(pb, node, helperID, protocol.ConflictTask(f.Base, f.Files), "合进计划分支会冲突："+strings.Join(f.Files, "、"))
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
		if helper != nil && helper.Spent != nil {
			spent := *helper.Spent
			n.Spent = &spent
		}
		return n
	})
	if protocol.AllSettled(next) {
		next.State = protocol.PlaybookStateRipe
		next = planWithNote(next, "")
	}
	p.putFarm(next)
	if next.State == protocol.PlaybookStateRipe {
		p.site.Notice(protocol.NoticeLevelInfo, "计划「"+next.Title+"」都做完了：在「计划」里看看改动，收获进主分支")
		p.tellManager(next.ID + "「" + next.Title + "」都做完了，等主人收获（plan_action harvest）。用两三句话告诉主人做成了什么。\n" + protocol.PlaybookText(next))
	}
}

// stepEnded: a step's helper ended a turn.
func (p *Playbooks) stepEnded(pb protocol.Playbook, node protocol.PlaybookNode, helper protocol.Helper, report protocol.FactReport) {
	switch report.Outcome {
	case protocol.OutcomeCompleted:
		p.stepDone(pb, node, helper.ID, report.Summary)
	case protocol.OutcomeFailed:
		p.sendBack(pb, node, helper.ID, protocol.RetryText(node), report.Summary)
	case protocol.OutcomeInterrupted:
		if pb.State != protocol.PlaybookStateRunning {
			return
		}
		pb.State = protocol.PlaybookStatePaused
		p.putFarm(planWithNote(pb, "「"+node.Title+"」被叫停了，计划先暂停；点继续接着做"))
	}
}

// follow is what follows a fact: a playbook helper's turn ended, one left; then whatever can start, starts.
func (p *Playbooks) follow(fact protocol.FactValue) {
	p.mu.Lock()
	defer p.mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("vibevalley: a playbook step went wrong: %v", r)
		}
	}()
	switch f := fact.(type) {
	case protocol.FactReport:
		helper := p.site.Helper(f.ID)
		if helper == nil || helper.Playbook == nil {
			break
		}
		tag := *helper.Playbook
		pb := p.get(tag.ID)
		if pb == nil || !protocol.IsOpen(*pb) {
			break
		}
		if tag.Node == nil {
			p.planned(*pb, *helper, f)
		} else if node := protocol.NodeOf(*pb, *tag.Node); node != nil && planStr(node.Helper) == helper.ID && node.State == protocol.NodeStateWorking {
			p.stepEnded(*pb, *node, *helper, f)
		}
	case protocol.FactLeft:
		// Sent home from outside the playbook (a full farm, the person): its step did not get done.
		for _, pb := range protocol.PlaybooksOf(p.site.State()) {
			if !protocol.IsOpen(pb) {
				continue
			}
			if p.planners[pb.ID] == f.ID && pb.State == protocol.PlaybookStatePlanning {
				p.giveUp(pb, "规划的帮工被请走了")
			}
			i := slices.IndexFunc(pb.Nodes, func(n protocol.PlaybookNode) bool {
				return planStr(n.Helper) == f.ID && n.State == protocol.NodeStateWorking
			})
			if i >= 0 {
				node := pb.Nodes[i]
				p.stepFailed(protocol.WithNode(pb, node.ID, planUnmanned), node, "帮工被请走了，这一步没做完")
			}
		}
	default:
		return
	}
	for _, pb := range protocol.PlaybooksOf(p.site.State()) {
		if pb.State == protocol.PlaybookStateRunning {
			p.schedule(pb.ID)
		}
	}
}

// resumeWorking picks up working steps again after a pause or a restart: finished ones are merged, idle ones go on.
func (p *Playbooks) resumeWorking(id string) {
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
		var helper *protocol.Helper
		if node.Helper != nil {
			helper = p.site.Helper(*node.Helper)
		}
		if helper == nil {
			p.putFarm(protocol.WithNode(*pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
				n = planUnmanned(n)
				n.State = protocol.NodeStateWaiting
				return n
			}))
			continue
		}
		if protocol.IsBusy(*helper) {
			continue
		}
		if _, ripe := helper.Phase.Value.(protocol.PhaseRipe); ripe {
			summary := "做完了"
			if helper.Last != nil {
				summary = helper.Last.Summary
			}
			p.stepDone(*pb, node, helper.ID, summary)
		} else {
			p.crew.Tell(helper.ID, "接着把这一步做完："+node.Title)
		}
	}
}

var planActionText = map[protocol.PlaybookAction]string{
	protocol.PlaybookActionStart: "开工", protocol.PlaybookActionPause: "暂停", protocol.PlaybookActionResume: "继续",
	protocol.PlaybookActionAbandon: "放弃", protocol.PlaybookActionHarvest: "收获",
}

func (p *Playbooks) Act(id string, action protocol.PlaybookAction, by protocol.PlaybookActor) (string, error) {
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
		branch := "vibevalley/pb-" + pb.ID + "-" + strconv.FormatInt(base.NowMs(), 36)
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
			p.crew.Dismiss(planner)
		}
		for _, n := range pb.Nodes {
			if n.State == protocol.NodeStateWorking && n.Helper != nil {
				p.crew.Dismiss(*n.Helper)
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
	case protocol.PlaybookActionHarvest:
		if pb.State != protocol.PlaybookStateRipe || pb.Branch == nil {
			return not()
		}
		merged, err := p.projects.HarvestBranch(pb.Project, *pb.Branch)
		if err != nil {
			why := err.Error()
			var f base.HarvestFailure
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
		p.site.Notice(protocol.NoticeLevelInfo, "收了计划「"+pb.Title+"」："+merged)
		return "收了计划「" + pb.Title + "」：" + merged, nil
	}
	return "", fmt.Errorf("不认识 %s 这个动作", action)
}

func (p *Playbooks) NodeAct(id, nodeID string, action protocol.NodeAction, by protocol.PlaybookActor) (string, error) {
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
		var helper *protocol.Helper
		if node.Helper != nil {
			helper = p.site.Helper(*node.Helper)
		}
		if helper != nil && !protocol.IsBusy(*helper) {
			// Its helper is still there: it goes on in the same session, with the (perhaps changed) job.
			p.put(protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
				n.State, n.Tries = protocol.NodeStateWorking, 0
				return n
			}), by, "")
			p.crew.Tell(helper.ID, protocol.RetryText(node)+"\n\n这一步的工单：\n"+node.Task)
			return helper.Name + " 接着做「" + node.Title + "」", nil
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
		if node.Helper != nil {
			p.crew.Dismiss(*node.Helper)
		}
		next := protocol.WithNode(pb, node.ID, func(n protocol.PlaybookNode) protocol.PlaybookNode {
			n = planUnmanned(n)
			n.State = protocol.NodeStateSkipped
			return n
		})
		if protocol.AllSettled(next) {
			next.State = protocol.PlaybookStateRipe
			next = planWithNote(next, "")
		}
		p.put(next, by, "")
		p.schedule(pb.ID)
		return "跳过了「" + node.Title + "」，后面的步骤照常开工", nil
	}
	return "", fmt.Errorf("不认识 %s 这个动作", action)
}

func (p *Playbooks) edited(id string, change func(protocol.Playbook) protocol.Edited, by protocol.PlaybookActor) (string, error) {
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

func (p *Playbooks) EditNode(id, node string, edit protocol.NodeEdit, by protocol.PlaybookActor) (string, error) {
	return p.edited(id, func(pb protocol.Playbook) protocol.Edited { return protocol.EditNode(pb, node, edit) }, by)
}

func (p *Playbooks) RemoveNode(id, node string, by protocol.PlaybookActor) (string, error) {
	return p.edited(id, func(pb protocol.Playbook) protocol.Edited { return protocol.RemoveNode(pb, node) }, by)
}

// Events is everything that happened to a playbook, oldest first.
func (p *Playbooks) Events(id string) []protocol.PlaybookEvent { return p.playbookLog.List(id) }

// Changes is what harvesting the playbook would merge into the main branch.
func (p *Playbooks) Changes(id string) (protocol.Changes, error) {
	pb, err := p.need(id)
	if err != nil {
		return protocol.Changes{}, err
	}
	if pb.Branch == nil {
		return protocol.Changes{}, errors.New("计划「" + pb.Title + "」还没开工，没有分支")
	}
	return p.projects.BranchChanges(pb.Project, *pb.Branch)
}

// start: back from a restart, then following the facts. The crew, started before, has already marked the turns that
// stopped with the server.
func (p *Playbooks) OnStart(ctx context.Context) error {
	p.mu.Lock()
	p.ctx = ctx
	for _, pb := range protocol.PlaybooksOf(p.site.State()) {
		switch {
		case pb.State == protocol.PlaybookStatePlanning:
			pb.State = protocol.PlaybookStateAbandoned
			p.putFarm(planWithNote(pb, "VibeValley 重启了，规划停在了半路：再说一遍要做什么"))
			for _, h := range p.site.State().Helpers {
				if h.Playbook != nil && h.Playbook.ID == pb.ID && h.Playbook.Node == nil {
					p.crew.Dismiss(h.ID)
				}
			}
		case pb.State == protocol.PlaybookStateRunning &&
			slices.ContainsFunc(pb.Nodes, func(n protocol.PlaybookNode) bool { return n.State == protocol.NodeStateWorking }):
			pb.State = protocol.PlaybookStatePaused
			p.putFarm(planWithNote(pb, "VibeValley 重启过，计划先暂停了；点继续接着做"))
		}
	}
	_, events, stop := p.site.Events()
	p.stop = stop
	for _, pb := range protocol.PlaybooksOf(p.site.State()) {
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

func (p *Playbooks) OnStop() {
	if p.stop != nil {
		p.stop()
	}
}
