package tickets

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
	"vibevalley/pkg/db/generated"
)

// The issue book (the tickets module, docs/concepts.md; the board calls an issue a 工单): every job from when it is
// written down until it closes, one id all along, and the helpers that worked it (its runs), oldest first. An issue is
// written down by the person (to do), or made as a helper is sent at once (by the manager, for a playbook's step);
// Dispatch sends its runs. It closes when its last run leaves, as the fact that the helper left says how (harvested,
// merged into a playbook, sent home, lost), and opens again with another run. Where it stands is read from its runs on
// the farm (protocol.IssueStatusOf). Kept in the database (issue, issue_run; pkg/db/queries/issue.sql); the open ones
// and the latest closed are in the core state too (issue facts), put there on start and after every change.
//
// A playbook (种植计划) is a parent issue with a plan, its steps the sub-issues (protocol/plan_issues.go): the
// playbooks write theirs whole (PutPlaybook), and they open and close as the plan says, not as their runs leave.
//
// Before the book, an issue was a helper's trajectory, and a reopened one another trajectory naming it: on start, every
// run the book does not know yet is put on its issue, a reopened one on the issue of the run it reopened. Before
// playbooks were issues, they were in farm.json: on start, those become their issues, and the runs of their planners
// and steps move onto them.

type Issues struct {
	db           *sql.DB
	q            *generated.Queries
	site         *base.Site
	trajectories *runs.Trajectories
	stop         func()
}

func newIssues(db *sql.DB, site *base.Site, trajectories *runs.Trajectories) (*Issues, error) {
	is := &Issues{db: db, q: generated.New(db), site: site, trajectories: trajectories}
	if err := is.adopt(context.Background()); err != nil {
		return nil, fmt.Errorf("issues: %w", err)
	}
	if err := is.adoptPlaybooks(context.Background(), site.LegacyPlaybooks()); err != nil {
		return nil, fmt.Errorf("issues: %w", err)
	}
	if err := is.restore(context.Background()); err != nil {
		return nil, fmt.Errorf("issues: %w", err)
	}
	return is, nil
}

// restore puts the issues the core state keeps into it.
func (is *Issues) restore(ctx context.Context) error {
	rows, err := is.q.KeptIssues(ctx, protocol.KeepClosedIssues)
	if err != nil {
		return err
	}
	all, err := is.q.RunsOfKept(ctx, protocol.KeepClosedIssues)
	if err != nil {
		return err
	}
	runs := map[string][]string{}
	for _, r := range all {
		runs[r.Issue] = append(runs[r.Issue], r.Run)
	}
	state := is.site.State()
	for _, row := range rows {
		is.site.Apply(protocol.FactIssue{Issue: issueOf(row, runs[row.ID], state)})
	}
	return nil
}

// publish puts issue id as the database has it now into the core state.
func (is *Issues) publish(id string) {
	issue, err := is.Get(id)
	if err != nil {
		return
	}
	is.site.Apply(protocol.FactIssue{Issue: issue})
}

// start follows the helpers that leave: an issue closes with its last run, as the fact says.
func (is *Issues) OnStart(ctx context.Context) error {
	_, events, stop := is.site.Events()
	is.stop = stop
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok {
					return
				}
				if left, ok := e.Value.(protocol.FactLeft); ok {
					is.left(ctx, left)
				}
			}
		}
	}()
	return nil
}

func (is *Issues) OnStop() {
	if is.stop != nil {
		is.stop()
	}
}

// left closes the issue whose last run just left; a playbook's issues close as the playbook says.
func (is *Issues) left(ctx context.Context, f protocol.FactLeft) {
	issue, err := is.q.IssueOfRun(ctx, f.ID)
	if err != nil {
		return
	}
	if row, err := is.q.GetIssue(ctx, issue); err != nil || row.Plan.Valid || row.Step.Valid {
		return
	}
	if runs, err := is.q.RunsOf(ctx, issue); err != nil || len(runs) == 0 || runs[len(runs)-1] != f.ID {
		return
	}
	if is.q.CloseIssue(ctx, generated.CloseIssueParams{ClosedAt: issueAt(base.NowMs()), Closed: issueClosed(f.Closed), ID: issue}) == nil {
		is.publish(issue)
	}
}

// ── Reading ──────────────────────────────────────────────────────────────────

func issueOf(row generated.Issue, runs []string, state protocol.FarmState) protocol.Issue {
	out := protocol.Issue{
		ID: row.ID, Title: row.Title, Description: row.Description, Priority: protocol.Priority(row.Priority), CreatedAt: row.CreatedAt, Runs: []string{},
	}
	if row.Project.Valid {
		out.Project = &row.Project.String
	}
	if row.Agent.Valid {
		out.Agent = &row.Agent.String
	}
	if row.QueuedAt.Valid {
		out.QueuedAt = &row.QueuedAt.Int64
	}
	if row.ClosedAt.Valid {
		out.ClosedAt = &row.ClosedAt.Int64
	}
	if row.Closed.Valid {
		how := protocol.IssueClose(row.Closed.String)
		out.Closed = &how
	}
	if row.Parent.Valid {
		out.Parent = &row.Parent.String
	}
	if row.Schedule.Valid {
		out.Schedule = &row.Schedule.Int64
	}
	if row.BlockedBy.Valid {
		_ = json.Unmarshal([]byte(row.BlockedBy.String), &out.BlockedBy)
	}
	if row.Plan.Valid {
		var plan protocol.IssuePlan
		if json.Unmarshal([]byte(row.Plan.String), &plan) == nil {
			out.Plan = &plan
		}
	}
	if row.Step.Valid {
		var step protocol.IssueStep
		if json.Unmarshal([]byte(row.Step.String), &step) == nil {
			out.Step = &step
		}
	}
	if runs != nil {
		out.Runs = runs
	}
	if len(out.Runs) == 0 || out.Step != nil {
		out.Rank = row.Rank
	}
	out.Status = protocol.IssueStatusOf(out, state)
	return out
}

// List is every issue with where it stands: the ones not sent yet in the board's order first, then the newest first.
func (is *Issues) List() ([]protocol.Issue, error) {
	ctx := context.Background()
	rows, err := is.q.ListIssues(ctx)
	if err != nil {
		return nil, err
	}
	all, err := is.q.AllRuns(ctx)
	if err != nil {
		return nil, err
	}
	runs := map[string][]string{}
	for _, r := range all {
		runs[r.Issue] = append(runs[r.Issue], r.Run)
	}
	state := is.site.State()
	out := make([]protocol.Issue, 0, len(rows))
	for _, row := range rows {
		out = append(out, issueOf(row, runs[row.ID], state))
	}
	slices.SortStableFunc(out, protocol.IssueOrder)
	return out, nil
}

// Get is the issue id, or the one run id worked; FarmMissing when there is none.
func (is *Issues) Get(id string) (protocol.Issue, error) {
	ctx := context.Background()
	issue := id
	if owner, err := is.q.IssueOfRun(ctx, id); err == nil {
		issue = owner
	}
	row, err := is.q.GetIssue(ctx, issue)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.Issue{}, protocol.FarmMissing{What: "工单 " + id}
	}
	if err != nil {
		return protocol.Issue{}, err
	}
	runs, err := is.q.RunsOf(ctx, issue)
	if err != nil {
		return protocol.Issue{}, err
	}
	return issueOf(row, runs, is.site.State()), nil
}

// unsent is an issue that is still only written down (to do, or queued): what may be changed, moved or removed.
func (is *Issues) unsent(id string) (protocol.Issue, error) {
	issue, err := is.Get(id)
	if err != nil {
		return issue, err
	}
	if issue.Plan != nil || issue.Step != nil {
		return issue, protocol.FarmRefused{Reason: "这是种植计划的工单：在计划里改"}
	}
	if len(issue.Runs) > 0 {
		return issue, protocol.FarmRefused{Reason: "这张工单已经开工了"}
	}
	return issue, nil
}

// ── Writing down ─────────────────────────────────────────────────────────────

// Add writes a job down, last in the board's order.
func (is *Issues) Add(in protocol.IssueRequest) (protocol.Issue, error) { return is.add(in, nil) }

// AddScheduled writes down the job schedule made, come due: an occurrence of a recurring issue.
func (is *Issues) AddScheduled(in protocol.IssueRequest, schedule int64) (protocol.Issue, error) {
	return is.add(in, &schedule)
}

func (is *Issues) add(in protocol.IssueRequest, schedule *int64) (protocol.Issue, error) {
	title, description, err := issueWords(in)
	if err != nil {
		return protocol.Issue{}, err
	}
	id := "t" + base.Code(8)
	if err := is.q.AddIssue(context.Background(), generated.AddIssueParams{
		ID: id, Title: title, Description: description, Project: issueNull(in.Project), Agent: issueNull(in.Agent), Priority: string(issuePriority(in.Priority)),
		CreatedAt: base.NowMs(), Schedule: issueSchedule(schedule),
	}); err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

// Edit changes what an issue not sent yet says, where and by whom.
func (is *Issues) Edit(id string, in protocol.IssueRequest) (protocol.Issue, error) {
	if _, err := is.unsent(id); err != nil {
		return protocol.Issue{}, err
	}
	title, description, err := issueWords(in)
	if err != nil {
		return protocol.Issue{}, err
	}
	if err := is.q.EditIssue(context.Background(), generated.EditIssueParams{
		Title: title, Description: description, Project: issueNull(in.Project), Agent: issueNull(in.Agent), Priority: string(issuePriority(in.Priority)), ID: id,
	}); err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

// Remove throws away an issue not sent yet.
func (is *Issues) Remove(id string) error {
	if _, err := is.unsent(id); err != nil {
		return err
	}
	if err := is.q.RemoveIssue(context.Background(), id); err != nil {
		return err
	}
	is.site.Apply(protocol.FactIssueGone{ID: id})
	return nil
}

// Move puts an issue not sent yet just before another one (before), or last when before is empty or not there;
// answers the list.
func (is *Issues) Move(id, before string) ([]protocol.Issue, error) {
	if _, err := is.unsent(id); err != nil {
		return nil, err
	}
	all, err := is.List()
	if err != nil {
		return nil, err
	}
	order := []string{}
	for _, issue := range all {
		if len(issue.Runs) == 0 && issue.ID != id {
			order = append(order, issue.ID)
		}
	}
	at := slices.Index(order, before)
	if at < 0 {
		at = len(order)
	}
	order = slices.Insert(order, at, id)
	tx, err := is.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	q := is.q.WithTx(tx)
	for rank, each := range order {
		if err := q.PlaceIssue(context.Background(), generated.PlaceIssueParams{Rank: int64(rank), ID: each}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	for _, each := range order {
		is.publish(each)
	}
	return is.List()
}

// Queue puts an issue not sent yet in the queue for a free bed, or takes it out.
func (is *Issues) Queue(id string, queued bool) (protocol.Issue, error) {
	if _, err := is.unsent(id); err != nil {
		return protocol.Issue{}, err
	}
	ctx := context.Background()
	var err error
	if queued {
		err = is.q.QueueIssue(ctx, generated.QueueIssueParams{At: issueAt(base.NowMs()), ID: id})
	} else {
		err = is.q.UnqueueIssue(ctx, id)
	}
	if err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

// Ran puts the helper's run on issue id, which opens (again) and leaves the queue; an issue not written down first
// (the manager sending someone at once, a playbook's step) is made from the helper's job.
func (is *Issues) Ran(id string, helper protocol.Helper) error {
	tx, err := is.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx, q := context.Background(), is.q.WithTx(tx)
	title, description := protocol.SplitJob(helper.Task)
	if err := q.OpenIssue(ctx, generated.OpenIssueParams{
		ID: id, Title: title, Description: description, Project: issueNull(helper.Project), Agent: issueNull(&helper.Agent), CreatedAt: helper.HiredAt,
	}); err != nil {
		return err
	}
	if err := q.AddRun(ctx, generated.AddRunParams{Run: helper.ID, Issue: id, StartedAt: helper.HiredAt}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	is.publish(id)
	return nil
}

// ── Playbooks ────────────────────────────────────────────────────────────────

// family is issue id and its sub-issues as the database has them.
func (is *Issues) family(ctx context.Context, q *generated.Queries, id string) ([]protocol.Issue, error) {
	rows, err := q.Family(ctx, id)
	if err != nil {
		return nil, err
	}
	all, err := q.RunsOfFamily(ctx, id)
	if err != nil {
		return nil, err
	}
	runs := map[string][]string{}
	for _, r := range all {
		runs[r.Issue] = append(runs[r.Issue], r.Run)
	}
	state := is.site.State()
	out := make([]protocol.Issue, 0, len(rows))
	for _, row := range rows {
		out = append(out, issueOf(row, runs[row.ID], state))
	}
	return out, nil
}

// putFamily writes issues, a playbook's, over what before was of it; a sub-issue no longer there goes. Answers what
// went. The caller commits.
func putFamily(ctx context.Context, q *generated.Queries, issues, before []protocol.Issue) ([]string, error) {
	for _, t := range issues {
		params := generated.PutIssueParams{
			ID: t.ID, Title: t.Title, Description: t.Description, Project: issueNull(t.Project), Agent: issueNull(t.Agent),
			Priority: string(t.Priority), Rank: t.Rank, CreatedAt: t.CreatedAt, Closed: issueClosed(t.Closed),
			Parent: issueNull(t.Parent), BlockedBy: issueJSON(t.BlockedBy, len(t.BlockedBy) > 0), Plan: issueJSON(t.Plan, t.Plan != nil),
			Step: issueJSON(t.Step, t.Step != nil),
		}
		if t.ClosedAt != nil {
			params.ClosedAt = issueAt(*t.ClosedAt)
		}
		if err := q.PutIssue(ctx, params); err != nil {
			return nil, err
		}
	}
	var gone []string
	for _, old := range before {
		if !slices.ContainsFunc(issues, func(t protocol.Issue) bool { return t.ID == old.ID }) {
			if err := q.RemoveIssue(ctx, old.ID); err != nil {
				return nil, err
			}
			gone = append(gone, old.ID)
		}
	}
	return gone, nil
}

// PutPlaybook writes a playbook as its issues, and puts them into the core state: the steps first, so that the
// playbook is whole when its parent issue changes.
func (is *Issues) PutPlaybook(pb protocol.Playbook) error {
	ctx := context.Background()
	before, err := is.family(ctx, is.q, pb.ID)
	if err != nil {
		return err
	}
	issues := protocol.PlaybookIssues(pb, before, base.NowMs())
	tx, err := is.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	gone, err := putFamily(ctx, is.q.WithTx(tx), issues, before)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, id := range gone {
		is.site.Apply(protocol.FactIssueGone{ID: id})
	}
	for _, t := range append(issues[1:], issues[0]) {
		is.publish(t.ID)
	}
	return nil
}

// NextPlaybookID is the id the next playbook gets, after every one there has been.
func (is *Issues) NextPlaybookID() (string, error) {
	ids, err := is.q.PlanIDs(context.Background())
	if err != nil {
		return "", err
	}
	return protocol.NextPlaybookID(ids), nil
}

// adoptPlaybooks makes the playbooks farm.json had into their issues, unless they are there already, and moves the
// runs of the issues their planners and steps worked onto them.
func (is *Issues) adoptPlaybooks(ctx context.Context, legacy []protocol.Playbook) error {
	if len(legacy) == 0 {
		return nil
	}
	tagged, err := is.q.TaggedIssues(ctx)
	if err != nil {
		return err
	}
	tx, err := is.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := is.q.WithTx(tx)
	for _, pb := range legacy {
		if _, err := q.GetIssue(ctx, pb.ID); err == nil {
			continue
		}
		issues := protocol.PlaybookIssues(pb, nil, pb.CreatedAt)
		if _, err := putFamily(ctx, q, issues, nil); err != nil {
			return err
		}
		for _, t := range tagged {
			var tag protocol.HelperPlaybook
			if json.Unmarshal([]byte(t.Playbook.String), &tag) != nil || tag.ID != pb.ID {
				continue
			}
			dest := pb.ID
			if tag.Node != nil && slices.ContainsFunc(issues, func(x protocol.Issue) bool { return x.ID == protocol.StepIssueID(pb.ID, *tag.Node) }) {
				dest = protocol.StepIssueID(pb.ID, *tag.Node)
			}
			if err := q.MoveRuns(ctx, generated.MoveRunsParams{Dest: dest, Src: t.ID}); err != nil {
				return err
			}
			if err := q.RemoveIssue(ctx, t.ID); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// ── Before the book ──────────────────────────────────────────────────────────

// adopt puts every run the book does not know yet on its issue, oldest first: the one its head names, the one of the
// run it reopened, else an issue of its own with the run's id. An issue stands as its last run left it.
func (is *Issues) adopt(ctx context.Context) error {
	heads := is.trajectories.List("")
	slices.Reverse(heads)
	all, err := is.q.AllRuns(ctx)
	if err != nil {
		return err
	}
	known := map[string]string{}
	for _, r := range all {
		known[r.Run] = r.Issue
	}
	tx, err := is.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	q := is.q.WithTx(tx)
	for _, h := range heads {
		if h.Agent == nil || known[h.ID] != "" {
			continue
		}
		issue := ""
		if h.Issue != nil {
			issue = *h.Issue
		} else if h.ReopenedFrom != nil {
			issue = known[*h.ReopenedFrom]
		}
		if issue == "" {
			issue = h.ID
		}
		title, description := h.Name, ""
		if h.Job != nil {
			if t, d := protocol.SplitJob(*h.Job); t != "" {
				title, description = t, d
			}
		}
		if err := q.KeepIssue(ctx, generated.KeepIssueParams{
			ID: issue, Title: title, Description: description, Project: issueNull(h.Project), Agent: issueNull(h.Agent), CreatedAt: h.StartedAt, Playbook: issuePlaybook(h.Playbook),
		}); err != nil {
			return err
		}
		if err := q.AddRun(ctx, generated.AddRunParams{Run: h.ID, Issue: issue, StartedAt: h.StartedAt}); err != nil {
			return err
		}
		closed := generated.CloseIssueParams{ID: issue}
		if h.EndedAt != nil {
			closed.ClosedAt, closed.Closed = issueAt(*h.EndedAt), issueClosed(h.Closed)
		}
		if err := q.CloseIssue(ctx, closed); err != nil {
			return err
		}
		known[h.ID] = issue
	}
	return tx.Commit()
}

// ── Small things ─────────────────────────────────────────────────────────────

// issueTitle is an issue's title, short enough for a notice.
func issueTitle(issue protocol.Issue) string { return runs.Cut(issue.Title, 40) }

// issueWords is the title and description asked for, trimmed; a title is a line, and there must be one.
func issueWords(in protocol.IssueRequest) (string, string, error) {
	title, rest := protocol.SplitJob(in.Title)
	if title == "" {
		return "", "", protocol.FarmRefused{Reason: "工单没有标题"}
	}
	description := base.Trim(in.Description)
	if rest != "" {
		description = strings.TrimSpace(rest + "\n\n" + description)
	}
	return title, description, nil
}

func issuePriority(p *protocol.Priority) protocol.Priority {
	if p == nil {
		return protocol.PriorityNormal
	}
	return *p
}

func issueNull(s *string) sql.NullString {
	if s == nil || base.Trim(*s) == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: base.Trim(*s), Valid: true}
}

func issueAt(ms int64) sql.NullInt64 { return sql.NullInt64{Int64: ms, Valid: true} }

func issueSchedule(id *int64) sql.NullInt64 {
	if id == nil {
		return sql.NullInt64{}
	}
	return issueAt(*id)
}

func issueClosed(how *protocol.IssueClose) sql.NullString {
	if how == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: string(*how), Valid: true}
}

func issuePlaybook(pb *protocol.HelperPlaybook) sql.NullString { return issueJSON(pb, pb != nil) }

// issueJSON is v as a JSON column, when there is one.
func issueJSON(v any, there bool) sql.NullString {
	if !there {
		return sql.NullString{}
	}
	body, err := json.Marshal(v)
	if err != nil {
		return sql.NullString{}
	}
	return sql.NullString{String: string(body), Valid: true}
}
