package tickets

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/chat"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

// Tests shorten it.
var dispatchTryEvery = 5 * time.Second

type Dispatch struct {
	site         *base.Site
	store        *base.Store
	runtimes     *runs.Runtimes
	trajectories *runs.Trajectories
	crew         *runs.Crew
	issues       *Issues
	chat         *chat.Chat
	schedules    *Schedules
	stop         func()
	// One round of the queue at a time.
	trying sync.Mutex
}

func newDispatch(site *base.Site, store *base.Store, runtimes *runs.Runtimes, trajectories *runs.Trajectories, crew *runs.Crew, issues *Issues, chat *chat.Chat, schedules *Schedules) (*Dispatch, error) {
	return &Dispatch{site: site, store: store, runtimes: runtimes, trajectories: trajectories, crew: crew, issues: issues, chat: chat, schedules: schedules}, nil
}

func (d *Dispatch) OnStart(ctx context.Context) error {
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
				if v.Schedule.Agent != nil {
					d.scheduled(ctx, v.Schedule)
				}
			}
		}
	}()
	go func() {
		for base.Sleep(ctx, dispatchTryEvery) {
			d.TryQueued(ctx)
		}
	}()
	return nil
}

func (d *Dispatch) OnStop() {
	if d.stop != nil {
		d.stop()
	}
}

func (d *Dispatch) scheduled(ctx context.Context, s protocol.FarmSchedule) {
	channel := d.chat.ChannelOf(s.Channel)
	project := s.Project
	if project == nil && channel.Project != "" {
		project = &channel.Project
	}
	issue, err := d.issues.AddScheduled(protocol.IssueRequest{Title: s.Name, Description: s.Text, Project: project, Agent: s.Agent}, s.ID)
	if err == nil {
		_, err = d.Start(ctx, issue.ID, channel.ID)
	}
	if err != nil {
		d.chat.Notice(channel.ID, "定时「"+s.Name+"」开不了工，留在待办里："+err.Error(), "schedule_refused")
	}
}

func (d *Dispatch) Hire(ctx context.Context, agent protocol.AgentProfile, task, project string, opt base.HireOptions) base.Hired {
	if !agent.Enabled {
		return base.Hired{Refused: agent.Name + " 被停用了"}
	}
	for _, issue := range protocol.AgentIssues(agent, d.runtimes.Info(ctx, agent.Runtime)) {
		if issue.Level == "error" {
			return base.Hired{Refused: fmt.Sprintf("%s 派不出去：%s", agent.Name, issue.Text)}
		}
	}
	where := base.Trim(project)
	if where == "" {
		where = base.Trim(agent.Workdir)
	}
	if where == "" {
		return base.Hired{Refused: "没说在哪个项目里做：项目是工作目录下的一个文件夹"}
	}
	if full := d.crew.NoRoom(agent.Runtime, where); full != "" {
		return base.Hired{Refused: full}
	}
	// A full farm sends home whoever has been idle longest.
	evicted := ""
	if helpers := d.site.State().Helpers; len(helpers) >= protocol.MaxRunning {
		var oldest *protocol.Helper
		for i := range helpers {
			if !protocol.IsBusy(helpers[i]) && (oldest == nil || helpers[i].HiredAt < oldest.HiredAt) {
				oldest = &helpers[i]
			}
		}
		if oldest != nil {
			evicted = oldest.Name
			d.crew.Dismiss(oldest.ID)
		}
	}
	if opt.Issue == "" {
		opt.Issue = "t" + base.Code(8)
	}
	hired := d.crew.Send(ctx, agent, task, where, opt)
	if hired.Helper != nil {
		hired.Evicted = evicted
		if err := d.issues.Ran(opt.Issue, *hired.Helper); err != nil {
			log.Printf("vibevalley: issue %s: %v", opt.Issue, err)
		}
	}
	return hired
}

func (d *Dispatch) Start(ctx context.Context, id string, channel int64) (protocol.Dispatched, error) {
	issue, agent, project, err := d.ready(id)
	if err != nil {
		return protocol.Dispatched{}, err
	}
	if full := d.crew.NoRoom(agent.Runtime, project); full != "" {
		if _, err := d.issues.Queue(issue.ID, true); err != nil {
			return protocol.Dispatched{}, err
		}
		why := full + "：排上队了，有空地就自动开工"
		return protocol.Dispatched{Queued: &why}, nil
	}
	helper, err := d.send(ctx, issue, agent, project, channel)
	if err != nil {
		return protocol.Dispatched{}, err
	}
	return protocol.Dispatched{Helper: &helper}, nil
}

func (d *Dispatch) ready(id string) (protocol.Issue, protocol.AgentProfile, string, error) {
	issue, err := d.issues.unsent(id)
	if err != nil {
		return issue, protocol.AgentProfile{}, "", err
	}
	if issue.Agent == nil {
		return issue, protocol.AgentProfile{}, "", protocol.FarmRefused{Reason: "还没选派哪个帮工档案"}
	}
	agent := d.store.Agent(*issue.Agent)
	if agent == nil {
		return issue, protocol.AgentProfile{}, "", protocol.FarmRefused{Reason: "帮工档案 " + *issue.Agent + " 不在了"}
	}
	project := agent.Workdir
	if issue.Project != nil {
		project = *issue.Project
	}
	return issue, *agent, project, nil
}

func (d *Dispatch) send(ctx context.Context, issue protocol.Issue, agent protocol.AgentProfile, project string, channel int64) (string, error) {
	hired := d.Hire(ctx, agent, protocol.IssueJob(issue), project, base.HireOptions{Channel: &channel, Issue: issue.ID})
	if hired.Refused != "" || hired.Helper == nil {
		return "", protocol.FarmRefused{Reason: hired.Refused}
	}
	return hired.Helper.ID, nil
}

// In the board's order; one that cannot go any more leaves the queue, said in a notice.
func (d *Dispatch) TryQueued(ctx context.Context) {
	d.trying.Lock()
	defer d.trying.Unlock()
	all, err := d.issues.List()
	if err != nil {
		log.Printf("vibevalley: issues: %v", err)
		return
	}
	for _, issue := range all {
		if issue.Status != protocol.IssueStatusQueued {
			continue
		}
		title := issueTitle(issue)
		_, agent, project, err := d.ready(issue.ID)
		if err == nil && d.crew.NoRoom(agent.Runtime, project) != "" {
			continue
		}
		var helper string
		if err == nil {
			helper, err = d.send(ctx, issue, agent, project, d.chat.Square())
		}
		if err != nil {
			_, _ = d.issues.Queue(issue.ID, false)
			d.site.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("排队的「%s」开不了工，留在待办里：%v", title, err))
			continue
		}
		d.site.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("排队的「%s」开工了：%s", title, helper))
	}
}

const crewReopenDefault = "接着把这张工单做完"

func (d *Dispatch) Reopen(ctx context.Context, id, text string, channel int64) (string, error) {
	issue, err := d.issues.Get(id)
	if err != nil {
		return "", err
	}
	if issue.Plan != nil || issue.Step != nil || (issue.Closed != nil && *issue.Closed == protocol.IssueCloseMerged) {
		return "", protocol.FarmRefused{Reason: "这是种植计划的工单，跟着计划走：在计划里重试这一步，或者重开整个计划"}
	}
	if len(issue.Runs) == 0 {
		return "", protocol.FarmRefused{Reason: "这张工单还没开过工：直接开工"}
	}
	t := d.trajectories.Get(issue.Runs[len(issue.Runs)-1])
	if t == nil || t.Head.Agent == nil {
		return "", protocol.FarmMissing{What: "工单 " + id}
	}
	head := t.Head
	switch {
	case issue.Status != protocol.IssueStatusClosed:
		return "", protocol.FarmRefused{Reason: head.Name + " 还在做这张工单：直接给它带话"}
	}
	agent := d.store.Agent(*head.Agent)
	if agent == nil {
		return "", protocol.FarmRefused{Reason: "派它的帮工档案 " + *head.Agent + " 不在了"}
	}
	project := ""
	if issue.Project != nil {
		project = *issue.Project
	}
	hired := d.Hire(ctx, *agent, crewReopenTask(issue, head, text), project, base.HireOptions{Channel: &channel, Issue: issue.ID})
	if hired.Refused != "" || hired.Helper == nil {
		return "", protocol.FarmRefused{Reason: hired.Refused}
	}
	return hired.Helper.ID, nil
}

func crewReopenTask(issue protocol.Issue, head protocol.TrajectoryHead, text string) string {
	now := base.Trim(text)
	if now == "" {
		now = crewReopenDefault
	}
	var b strings.Builder
	b.WriteString(now)
	fmt.Fprintf(&b, "\n\n（这张工单重开了，上一次是 %s（%s）做的。）", head.Name, head.ID)
	b.WriteString("\n这张工单原来是：" + runs.Cut(protocol.IssueJob(issue), runs.AskedMax))
	if head.Closed != nil {
		b.WriteString("\n它是怎么关的：" + crewClosedText[*head.Closed])
	}
	if head.Outcome != nil && head.Summary != nil {
		b.WriteString(fmt.Sprintf("\n最后一轮%s：%s", crewOutcomeText[*head.Outcome], runs.Cut(base.Trim(*head.Summary), runs.AskedMax)))
	}
	b.WriteString("\n先看看项目现在的样子，再接着做。")
	return b.String()
}

var crewClosedText = map[protocol.IssueClose]string{
	protocol.IssueCloseHarvested: "收获了，改动已经合进项目的主分支",
	protocol.IssueCloseMerged:    "做完了，改动合进了种植计划的分支",
	protocol.IssueCloseDismissed: "没收获就收工了，改动没有合进主分支",
	protocol.IssueCloseLost:      "干活的目录丢了，改动可能不在了",
}

var crewOutcomeText = map[protocol.Outcome]string{
	protocol.OutcomeCompleted:   "做完了",
	protocol.OutcomeFailed:      "没做成",
	protocol.OutcomeInterrupted: "被叫停了",
}
