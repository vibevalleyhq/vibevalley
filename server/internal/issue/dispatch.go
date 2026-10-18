package issue

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/schedule"
	"vibevalley/internal/session"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Tests shorten it.
var dispatchTryEvery = 5 * time.Second

type dispatch struct {
	projects  *project.Service
	core      *core.Service
	store     *agent.Service
	runtimes  *runtime.Service
	run       *session.Service
	issues    *issues
	chat      *channel.Service
	schedules *schedule.Service
	stop      func()
	// Issues for the manager, handed to it (manager.go).
	forManager *base.Hub[ManagerWork]
	// One round of the queue at a time.
	trying sync.Mutex
}

func newDispatch(projects *project.Service, core *core.Service, store *agent.Service, runtimes *runtime.Service, sessions *session.Service, issues *issues, chat *channel.Service, schedules *schedule.Service) (*dispatch, error) {
	return &dispatch{projects: projects, core: core, store: store, runtimes: runtimes, run: sessions, issues: issues, chat: chat, schedules: schedules, forManager: base.NewHub[ManagerWork]()}, nil
}

func (d *dispatch) OnStart(ctx context.Context) error {
	due, stop := d.schedules.Due().Subscribe()
	d.stop = stop
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case v, ok := <-due:
				if !ok {
					return
				}
				d.scheduled(ctx, v)
			}
		}
	}()
	go func() {
		for clock.Sleep(ctx, dispatchTryEvery) {
			d.TryQueued(ctx)
		}
	}()
	return nil
}

func (d *dispatch) OnStop() {
	if d.stop != nil {
		d.stop()
	}
}

// A schedule has one issue, for the session it names or for the manager; each time it comes due is a run of that issue.
func (d *dispatch) scheduled(ctx context.Context, due schedule.Due) {
	s := due.Schedule
	channel := d.chat.ChannelOf(s.Channel)
	id := s.ID
	by := protocol.RunTrigger{Kind: protocol.RunTriggerKindSchedule, Schedule: &id, Missed: due.Missed}
	issue, found := d.issues.OfSchedule(s.ID)
	var err error
	if !found {
		agent := protocol.ManagerAgent
		if s.Agent != nil {
			agent = *s.Agent
		}
		project := s.Project
		if project == nil && channel.Project != "" {
			project = &channel.Project
		}
		if issue, err = d.issues.AddScheduled(protocol.IssueRequest{Title: s.Name, Description: s.Text, Project: project, Assignee: &agent}, s.ID); err != nil {
			d.chat.Notice(channel.ID, "定时「"+s.Name+"」写不了工单："+err.Error(), "schedule_refused")
			return
		}
	}
	text := protocol.DueText(s, due.Missed)
	switch {
	case protocol.IsForManager(issue):
		err = d.toManager(issue, channel.ID, by, &s)
	case !found || issue.Status == protocol.IssueStatusBacklog || issue.Status == protocol.IssueStatusTodo:
		_, err = d.start(ctx, issue.ID, channel.ID, &by)
	case isClosed(issue.Status):
		_, err = d.reopen(ctx, issue.ID, text, channel.ID, by)
	default:
		if refused := d.run.Deliver(issue.Sessions[len(issue.Sessions)-1], text, by); refused.Kind == "refused" {
			err = errors.New(refused.Reason)
		}
	}
	if err != nil {
		d.chat.Notice(channel.ID, "定时「"+s.Name+"」开不了工："+err.Error(), "schedule_refused")
	}
}

func (d *dispatch) Hire(ctx context.Context, agent protocol.Agent, task, project string, opt session.HireOptions) session.Hired {
	if agent.ID == protocol.ManagerAgent {
		return session.Hired{Refused: "管家不下地：派给一个帮工档案"}
	}
	if !agent.Enabled {
		return session.Hired{Refused: agent.Name + " 被停用了"}
	}
	for _, issue := range d.runtimes.Check(ctx, agent) {
		if issue.Level == "error" {
			return session.Hired{Refused: fmt.Sprintf("%s 派不出去：%s", agent.Name, issue.Text)}
		}
	}
	where := str.Trim(project)
	if where == "" {
		where = str.Trim(agent.Workdir)
	}
	if where == "" {
		return session.Hired{Refused: "没说在哪个项目里做：项目是工作目录下的一个文件夹"}
	}
	if full := d.run.NoRoom(agent.Runtime, where); full != "" {
		return session.Hired{Refused: full}
	}
	// A full farm sends home whoever has been idle longest.
	evicted := ""
	if sessions := d.core.State().Sessions; len(sessions) >= protocol.MaxRunning {
		var oldest *protocol.Session
		for i := range sessions {
			if !protocol.IsBusy(sessions[i]) && (oldest == nil || sessions[i].HiredAt < oldest.HiredAt) {
				oldest = &sessions[i]
			}
		}
		if oldest != nil {
			evicted = oldest.Name
			d.run.Dismiss(oldest.ID)
		}
	}
	if opt.Issue == "" {
		opt.Issue = base.NewID()
	} else if issue, err := d.issues.Get(opt.Issue); err == nil {
		opt.IssueNumber = issue.Number
	}
	opt.Hiring = func(w protocol.Session) error {
		return d.issues.Ran(opt.Issue, w)
	}
	hired := d.run.Send(ctx, agent, task, where, opt)
	if hired.Session != nil {
		hired.Evicted = evicted
	}
	return hired
}

func (d *dispatch) Start(ctx context.Context, id string, channel string) (protocol.Dispatched, error) {
	return d.start(ctx, id, channel, nil)
}

// by nil: the issue sent out.
func (d *dispatch) start(ctx context.Context, id string, channel string, by *protocol.RunTrigger) (protocol.Dispatched, error) {
	if issue, err := d.issues.Get(id); err == nil && protocol.IsForManager(issue) {
		trigger := protocol.RunTrigger{Kind: protocol.RunTriggerKindIssue}
		if by != nil {
			trigger = *by
		}
		return protocol.Dispatched{}, d.toManager(issue, channel, trigger, nil)
	}
	issue, agent, project, err := d.ready(id)
	if err != nil {
		return protocol.Dispatched{}, err
	}
	if issue.QueuedAt != nil {
		var queued protocol.RunTrigger
		channel, queued, err = d.issues.queuedDispatch(id)
		if err != nil {
			return protocol.Dispatched{}, err
		}
		by = &queued
	}
	if full := d.run.NoRoom(agent.Runtime, project); full != "" {
		if _, err := d.issues.queue(issue.ID, true, d.chat.ChannelOf(channel).ID, by); err != nil {
			return protocol.Dispatched{}, err
		}
		why := full + "：排上队了，有空地就自动开工"
		return protocol.Dispatched{Queued: &why}, nil
	}
	session, err := d.send(ctx, issue, agent, project, channel, by)
	if err != nil {
		return protocol.Dispatched{}, err
	}
	return protocol.Dispatched{Session: &session}, nil
}

func (d *dispatch) ready(id string) (protocol.Issue, protocol.Agent, string, error) {
	issue, err := d.issues.unsent(id)
	if err != nil {
		return issue, protocol.Agent{}, "", err
	}
	if issue.Assignee == nil {
		return issue, protocol.Agent{}, "", protocol.Refused{Reason: "还没选派哪个帮工档案"}
	}
	agent := d.store.Agent(*issue.Assignee)
	if agent == nil {
		return issue, protocol.Agent{}, "", protocol.Refused{Reason: "帮工档案 " + *issue.Assignee + " 不在了"}
	}
	project := agent.Workdir
	if issue.Project != nil {
		project = *issue.Project
	}
	return issue, *agent, project, nil
}

func (d *dispatch) send(ctx context.Context, issue protocol.Issue, agent protocol.Agent, project string, channel string, by *protocol.RunTrigger) (string, error) {
	hired := d.Hire(ctx, agent, issueJob(issue), project, session.HireOptions{Channel: &channel, Issue: issue.ID, Trigger: by})
	if hired.Refused != "" || hired.Session == nil {
		return "", protocol.Refused{Reason: hired.Refused}
	}
	return hired.Session.ID, nil
}

// In the board's order; one that cannot go any more leaves the queue, said in a notice.
func (d *dispatch) TryQueued(ctx context.Context) {
	d.trying.Lock()
	defer d.trying.Unlock()
	all, err := d.issues.List()
	if err != nil {
		log.Printf("vibevalley: issues: %v", err)
		return
	}
	for _, issue := range all {
		if issue.Status != protocol.IssueStatusTodo {
			continue
		}
		title := issueTitle(issue)
		_, agent, project, err := d.ready(issue.ID)
		if err == nil && d.run.NoRoom(agent.Runtime, project) != "" {
			continue
		}
		var session string
		if err == nil {
			channel, by, queuedErr := d.issues.queuedDispatch(issue.ID)
			err = queuedErr
			if err == nil {
				session, err = d.send(ctx, issue, agent, project, channel, &by)
			}
		}
		if err != nil {
			if _, unqueue := d.Queue(issue.ID, false); unqueue != nil {
				log.Printf("vibevalley: issue %s could not leave the queue: %v", issue.ID, unqueue)
				d.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("排队的「%s」开不了工：%v；也没能退回待办，还在队里", title, err))
				continue
			}
			d.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("排队的「%s」开不了工，留在待办里：%v", title, err))
			continue
		}
		d.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("排队的「%s」开工了：%s", title, session))
	}
}

const reopenDefault = "接着把这张工单做完"

func (d *dispatch) Reopen(ctx context.Context, id, text string, channel string) (string, error) {
	return d.reopen(ctx, id, text, channel, protocol.RunTrigger{Kind: protocol.RunTriggerKindComment})
}

func (d *dispatch) reopen(ctx context.Context, id, text string, channel string, by protocol.RunTrigger) (string, error) {
	issue, err := d.issues.Get(id)
	if err != nil {
		return "", err
	}
	if issue.Graph != nil || issue.Task != nil || (issue.Closed != nil && *issue.Closed == protocol.IssueCloseMergedIntoGraph) {
		return "", protocol.Refused{Reason: "这是种植计划的工单，跟着计划走：在计划里重试这一步，或者重开整个计划"}
	}
	if len(issue.Sessions) == 0 {
		return "", protocol.Refused{Reason: "这张工单还没开过工：直接开工"}
	}
	last := d.run.Get(issue.Sessions[len(issue.Sessions)-1])
	if last == nil {
		return "", protocol.Missing{What: "工单 " + id}
	}
	if !isClosed(issue.Status) {
		return "", protocol.Refused{Reason: last.Name + " 还在做这张工单：直接给它带话"}
	}
	agent := d.store.Agent(last.Agent)
	if agent == nil {
		return "", protocol.Refused{Reason: "派它的帮工档案 " + last.Agent + " 不在了"}
	}
	project := ""
	if issue.Project != nil {
		project = *issue.Project
	}
	previous := false
	if changes, err := d.projects.BranchChanges(project, fmt.Sprintf("vibevalley/issue-%d", issue.Number)); err == nil {
		previous = len(changes.Commits) > 0
	}
	hired := d.Hire(ctx, *agent, reopenTask(issue, *last, text, previous), project, session.HireOptions{Channel: &channel, Issue: issue.ID, Trigger: &by})
	if hired.Refused != "" || hired.Session == nil {
		return "", protocol.Refused{Reason: hired.Refused}
	}
	return hired.Session.ID, nil
}

func reopenTask(issue protocol.Issue, last protocol.Session, text string, previous bool) string {
	now := str.Trim(text)
	if now == "" {
		now = reopenDefault
	}
	var b strings.Builder
	b.WriteString(now)
	fmt.Fprintf(&b, "\n\n（这张工单重开了，上一次是 %s（%s）做的。）", last.Name, last.ID)
	b.WriteString("\n这张工单原来是：" + str.Cut(issueJob(issue), session.AskedMax))
	if closed, ok := last.Phase.Value.(protocol.PhaseClosed); ok {
		b.WriteString("\n它是怎么关的：" + closedText[closed.Closed])
	}
	if r := last.LastRun; r != nil {
		b.WriteString(fmt.Sprintf("\n最后一轮%s：%s", outcomeText[r.Outcome], str.Cut(str.Trim(r.Summary), session.AskedMax)))
	}
	if previous {
		b.WriteString("\n这条分支上已经有上次的提交，接着做")
	}
	b.WriteString("\n先看看项目现在的样子，再接着做。")
	return b.String()
}

var closedText = map[protocol.IssueClose]string{
	protocol.IssueCloseMerged:          "收获了，改动已经合进项目的主分支",
	protocol.IssueCloseMergedIntoGraph: "做完了，改动合进了种植计划的分支",
	protocol.IssueCloseDismissed:       "没收获就收工了，改动没有合进主分支",
	protocol.IssueCloseLost:            "干活的目录丢了，改动可能不在了",
}

var outcomeText = map[protocol.Outcome]string{
	protocol.OutcomeCompleted:   "做完了",
	protocol.OutcomeFailed:      "没做成",
	protocol.OutcomeInterrupted: "被叫停了",
}
