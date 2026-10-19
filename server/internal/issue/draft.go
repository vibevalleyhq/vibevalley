package issue

// An issue is written before it is sent: a session reads the code and drafts it in the issue's format, then leaves. The
// issue stays unsent all along: the drafting session is never one of its sessions (issue_session), and whatever it changed
// in the issue's worktree is reset away before it goes, so the work starts from the main branch.

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"sync"

	"vibevalley/internal/agent"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runtime"
	"vibevalley/internal/session"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/str"
)

type drafts struct {
	core     *core.Service
	issues   *issues
	dispatch *dispatch
	sessions *session.Service
	projects *project.Service
	chat     *channel.Service
	store    *agent.Service
	runtimes *runtime.Service
	stop     func()
	// One draft starts at a time: two clicks do not send two sessions.
	mu sync.Mutex
}

func newDrafts(core *core.Service, issues *issues, dispatch *dispatch, sessions *session.Service, projects *project.Service, chat *channel.Service, store *agent.Service, runtimes *runtime.Service) (*drafts, error) {
	return &drafts{core: core, issues: issues, dispatch: dispatch, sessions: sessions, projects: projects, chat: chat, store: store, runtimes: runtimes}, nil
}

func (d *drafts) OnStart(ctx context.Context) error {
	_, events, stop := d.core.Events()
	d.stop = stop
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok {
					return
				}
				if f, ok := e.Value.(protocol.FactReport); ok {
					d.handedBack(f)
				}
			}
		}
	}()
	return nil
}

func (d *drafts) OnStop() {
	if d.stop != nil {
		d.stop()
	}
}

// Draft sends a session to write the issue. word is what the owner wants; when the issue asks, it is the answer.
func (d *drafts) Draft(ctx context.Context, id, word, channel string) (protocol.Issue, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, err := d.issues.unsent(id)
	if err != nil {
		return t, err
	}
	switch {
	case protocol.IsForManager(t):
		return t, protocol.Refused{Reason: "这是派给管家的工单：管家自己会看"}
	case t.Status != protocol.IssueStatusBacklog:
		return t, protocol.Refused{Reason: "只有备选里的工单能起草：先挪回备选"}
	case t.Drafting != nil:
		return t, protocol.Refused{Reason: t.Drafting.Name + " 正在起草：等它交回来"}
	}
	chosen, err := d.drafter(ctx, t)
	if err != nil {
		return t, err
	}
	where := str.Trim(chosen.Workdir)
	if t.Project != nil {
		where = *t.Project
	}
	if where == "" {
		return t, protocol.Refused{Reason: "没说在哪个项目里做：先选一个项目"}
	}
	word = str.Trim(word)
	brief := draftBrief(t, word, where)
	if err := d.issues.beforeDraft(t, word, chosen.ID, where); err != nil {
		return t, err
	}
	// Always a worktree, even for a profile that works in the project folder: the reset after it must not touch the owner's checkout.
	worktree := true
	hired := d.dispatch.Hire(ctx, chosen, brief, where, session.HireOptions{
		Worktree: &worktree, Channel: &channel, Issue: id, Trigger: &protocol.RunTrigger{Kind: protocol.RunTriggerKindDraft}, Draft: true,
	})
	if hired.Session == nil {
		return t, protocol.Refused{Reason: hired.Refused}
	}
	// Its moves no longer hold todo while it drafts.
	d.issues.publish(id)
	return d.issues.Get(id)
}

// Who drafts: its assignee; else whoever was last sent to work in its project, if they can work now; else ChooseAgent.
func (d *drafts) drafter(ctx context.Context, t protocol.Issue) (protocol.Agent, error) {
	var candidates []session.Candidate
	for _, a := range d.store.Agents() {
		candidates = append(candidates, session.Candidate{Agent: a, Usable: d.runtimes.Assess(ctx, a).Usable()})
	}
	named := ""
	if t.Assignee != nil {
		if d.store.Agent(*t.Assignee) == nil {
			return protocol.Agent{}, protocol.Refused{Reason: "帮工档案 " + *t.Assignee + " 不在了"}
		}
		named = *t.Assignee
	} else if t.Project != nil {
		if last, err := d.issues.q.LastAssigneeIn(ctx, sql.NullString{String: *t.Project, Valid: true}); err == nil && last.Valid {
			for _, c := range candidates {
				if c.Agent.ID == last.String && c.Usable {
					named = last.String
				}
			}
		}
	}
	chosen := session.ChooseAgent(candidates, "起草 "+t.Title, named, "")
	if chosen == nil {
		return protocol.Agent{}, protocol.Refused{Reason: "没有能派的帮工来起草"}
	}
	return *chosen, nil
}

// A draft's session reported: what it hands back is written into the issue, or the thread says why not; then its worktree
// goes back to the main branch and it leaves.
func (d *drafts) handedBack(f protocol.FactReport) {
	h := d.core.Session(f.ID)
	if h == nil || !h.Draft || h.Issue == nil {
		return
	}
	id := *h.Issue
	said, place := "", project.Workplace{}
	if r := d.sessions.Find(f.ID); r != nil {
		said, place = r.LastText, r.Place
	}
	thread := d.chat.JobThread(f.ID)
	tell := func(text string) {
		if thread != nil {
			d.chat.Notice(*thread, text, "issue_draft")
			return
		}
		d.core.Notice(protocol.NoticeLevelWarn, text)
	}
	if f.Outcome == protocol.OutcomeCompleted {
		if draft, problem := parseDraft(said); problem != "" {
			tell(fmt.Sprintf("%s 交回来的草稿读不出来（%s），工单没动：再起草一次", h.Name, problem))
		} else if err := d.issues.drafted(id, draft, f.Asks); err != nil {
			tell("草稿没写进工单：" + err.Error())
		}
	} else {
		tell(fmt.Sprintf("%s 没起草完（%s），工单没动：再起草一次", h.Name, f.Summary))
	}
	if place.Branch != "" {
		if err := d.projects.Reset(place); err != nil {
			d.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("起草的 worktree 没能重置：%v", err))
		}
	}
	d.sessions.Dismiss(f.ID)
	d.issues.publish(id)
}

// An unsent issue going away (canceled or deleted) takes its draft with it: whoever drafts it goes home, and the worktree
// and empty branch drafts left are removed.
func (d *drafts) clearDraft(t protocol.Issue) {
	if t.Drafting != nil {
		if r := d.sessions.Find(t.Drafting.Session); r != nil && r.Place.Branch != "" {
			if err := d.projects.Reset(r.Place); err != nil {
				log.Printf("vibevalley: issue %s: its draft's worktree was not reset: %v", t.ID, err)
			}
		}
		d.sessions.Dismiss(t.Drafting.Session)
	}
	if t.Project != nil {
		if kept := d.projects.Clear(*t.Project, t.Number); kept != "" {
			d.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("「%s」取消了：%s", issueTitle(t), kept))
		}
	}
}

// Remove deletes an issue not yet sent, its draft with it.
func (s *Service) Remove(id string) error {
	t, err := s.issues.unsent(id)
	if err != nil {
		return err
	}
	s.clearDraft(t)
	return s.issues.Remove(id)
}

// Before its session is sent: the owner's first word is its title, the drafter and the project are its own unless it names
// them, and an answer clears what it asked.
func (is *issues) beforeDraft(t protocol.Issue, word, agent, where string) error {
	title, description := t.Title, t.Description
	if word != "" && len(t.Asks) == 0 && description == "" && len(t.Criteria) == 0 {
		title, description = splitJob(word)
	}
	project, assignee := where, agent
	if t.Project != nil {
		project = *t.Project
	}
	if t.Assignee != nil {
		assignee = *t.Assignee
	}
	tx, err := is.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx, q := context.Background(), is.q.WithTx(tx)
	if err := q.EditIssue(ctx, generated.EditIssueParams{
		Title: title, Description: description, Project: issueNull(&project), Assignee: issueNull(&assignee), Priority: string(t.Priority),
		Acceptance: string(t.Acceptance), Criteria: issueJSON(t.Criteria, len(t.Criteria) > 0), ID: t.ID,
	}); err != nil {
		return err
	}
	if word != "" && len(t.Asks) > 0 {
		if err := q.SetIssueAsks(ctx, generated.SetIssueAsksParams{ID: t.ID}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	is.publish(t.ID)
	return nil
}

// A draft read from its session: the words, the criteria and what it asks replace the last ones.
func (is *issues) drafted(id string, d issueDraft, asks []string) error {
	criteria := d.Criteria.kept()
	var open []string
	for _, a := range asks {
		if a = str.Trim(a); a != "" {
			open = append(open, a)
		}
	}
	if err := is.q.DraftIssue(context.Background(), generated.DraftIssueParams{
		ID: id, Title: d.Title, Description: draftDescription(d), Criteria: issueJSON(criteria, len(criteria) > 0), Asks: issueJSON(open, len(open) > 0),
	}); err != nil {
		return err
	}
	is.publish(id)
	return nil
}
