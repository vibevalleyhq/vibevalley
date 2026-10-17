package issue

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// An issue closes when its last session leaves, as the fact that the session left says how, and opens again with another session. A playbook's issues
// open and close as the plan says, not as their sessions leave.

type issues struct {
	db           *sql.DB
	q            *generated.Queries
	core         *core.Service
	trajectories *session.Service
	stop         func()
}

func newIssues(db *sql.DB, core *core.Service, trajectories *session.Service) (*issues, error) {
	is := &issues{db: db, q: generated.New(db), core: core, trajectories: trajectories}
	if err := is.restore(context.Background()); err != nil {
		return nil, fmt.Errorf("issues: %w", err)
	}
	return is, nil
}

func (is *issues) restore(ctx context.Context) error {
	rows, err := is.q.KeptIssues(ctx, protocol.KeepClosedIssues)
	if err != nil {
		return err
	}
	all, err := is.q.SessionsOfKept(ctx, protocol.KeepClosedIssues)
	if err != nil {
		return err
	}
	runs := map[string][]string{}
	for _, r := range all {
		runs[r.Issue] = append(runs[r.Issue], r.Session)
	}
	state := is.core.State()
	for _, row := range rows {
		is.core.Apply(protocol.FactIssue{Issue: issueOf(row, runs[row.ID], state)})
	}
	return nil
}

func (is *issues) publish(id string) {
	issue, err := is.Get(id)
	if err != nil {
		log.Printf("vibevalley: issue %s changed but could not be read back for the board: %v", id, err)
		return
	}
	is.core.Apply(protocol.FactIssue{Issue: issue})
}

func (is *issues) OnStart(ctx context.Context) error {
	is.closeManagersOpen(ctx)
	_, events, stop := is.core.Events()
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

func (is *issues) OnStop() {
	if is.stop != nil {
		is.stop()
	}
}

func (is *issues) left(ctx context.Context, f protocol.FactLeft) {
	issue, err := is.q.IssueOfSession(ctx, f.ID)
	if err != nil {
		return
	}
	if row, err := is.q.GetIssue(ctx, issue); err != nil || row.Plan.Valid || row.Step.Valid {
		return
	}
	if runs, err := is.q.SessionsOf(ctx, issue); err != nil || len(runs) == 0 || runs[len(runs)-1] != f.ID {
		return
	}
	if is.q.CloseIssue(ctx, generated.CloseIssueParams{ClosedAt: issueAt(clock.NowMs()), Closed: issueClosed(f.Closed), ID: issue}) == nil {
		is.publish(issue)
	}
}

func issueOf(row generated.Issue, runs []string, state protocol.CoreState) protocol.Issue {
	out := protocol.Issue{
		ID: row.ID, Number: row.Number, Title: row.Title, Description: row.Description, Priority: protocol.Priority(row.Priority),
		CreatedAt: row.CreatedAt, Sessions: []string{},
	}
	if row.Project.Valid {
		out.Project = &row.Project.String
	}
	if row.Assignee.Valid {
		out.Assignee = &row.Assignee.String
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
		out.Schedule = &row.Schedule.String
	}
	if row.BlockedBy.Valid {
		if err := json.Unmarshal([]byte(row.BlockedBy.String), &out.BlockedBy); err != nil {
			log.Printf("vibevalley: issue %s: what blocks it cannot be read: %v", row.ID, err)
		}
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
		out.Sessions = runs
	}
	if len(out.Sessions) == 0 || out.Step != nil {
		out.Rank = row.Rank
	}
	out.Status = protocol.IssueStatusOf(out, state)
	return out
}

func (is *issues) List() ([]protocol.Issue, error) {
	ctx := context.Background()
	rows, err := is.q.ListIssues(ctx)
	if err != nil {
		return nil, err
	}
	all, err := is.q.AllSessions(ctx)
	if err != nil {
		return nil, err
	}
	runs := map[string][]string{}
	for _, r := range all {
		runs[r.Issue] = append(runs[r.Issue], r.Session)
	}
	state := is.core.State()
	out := make([]protocol.Issue, 0, len(rows))
	for _, row := range rows {
		out = append(out, issueOf(row, runs[row.ID], state))
	}
	slices.SortStableFunc(out, protocol.IssueOrder)
	return out, nil
}

func (is *issues) Get(id string) (protocol.Issue, error) {
	ctx := context.Background()
	issue := id
	if owner, err := is.q.IssueOfSession(ctx, id); err == nil {
		issue = owner
	}
	row, err := is.q.GetIssue(ctx, issue)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.Issue{}, protocol.Missing{What: "工单 " + id}
	}
	if err != nil {
		return protocol.Issue{}, err
	}
	runs, err := is.q.SessionsOf(ctx, issue)
	if err != nil {
		return protocol.Issue{}, err
	}
	return issueOf(row, runs, is.core.State()), nil
}

// Latest is the issue's newest session, the one its merge, changes, comments and cancel act on; a reopen makes another.
func (is *issues) Latest(id string) (string, error) {
	issue, err := is.Get(id)
	if err != nil {
		return "", err
	}
	if len(issue.Sessions) == 0 {
		return "", protocol.Refused{Reason: "这张工单还没开工"}
	}
	return issue.Sessions[len(issue.Sessions)-1], nil
}

func (is *issues) unsent(id string) (protocol.Issue, error) {
	issue, err := is.Get(id)
	if err != nil {
		return issue, err
	}
	if issue.Plan != nil || issue.Step != nil {
		return issue, protocol.Refused{Reason: "这是种植计划的工单：在计划里改"}
	}
	if len(issue.Sessions) > 0 {
		return issue, protocol.Refused{Reason: "这张工单已经开工了"}
	}
	return issue, nil
}

func (is *issues) Add(in protocol.IssueRequest) (protocol.Issue, error) { return is.add(in, nil) }

func (is *issues) AddScheduled(in protocol.IssueRequest, schedule string) (protocol.Issue, error) {
	return is.add(in, &schedule)
}

func (is *issues) add(in protocol.IssueRequest, schedule *string) (protocol.Issue, error) {
	title, description, err := issueWords(in)
	if err != nil {
		return protocol.Issue{}, err
	}
	id := base.NewID()
	if err := is.q.AddIssue(context.Background(), generated.AddIssueParams{
		ID: id, Title: title, Description: description, Project: issueNull(in.Project), Assignee: issueNull(in.Assignee), Priority: string(issuePriority(in.Priority)),
		CreatedAt: clock.NowMs(), Schedule: issueSchedule(schedule),
	}); err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

// Edit changes what upd gives and keeps the rest.
func (is *issues) Edit(id string, upd protocol.IssueUpdate) (protocol.Issue, error) {
	was, err := is.unsent(id)
	if err != nil {
		return protocol.Issue{}, err
	}
	in := protocol.IssueRequest{Title: was.Title, Description: was.Description, Project: was.Project, Assignee: was.Assignee, Priority: &was.Priority}
	if upd.Title != nil {
		in.Title = *upd.Title
	}
	if upd.Description != nil {
		in.Description = *upd.Description
	}
	if upd.Project != nil {
		in.Project = upd.Project
	}
	if upd.Assignee != nil {
		in.Assignee = upd.Assignee
	}
	if upd.Priority != nil {
		in.Priority = upd.Priority
	}
	title, description, err := issueWords(in)
	if err != nil {
		return protocol.Issue{}, err
	}
	if err := is.q.EditIssue(context.Background(), generated.EditIssueParams{
		Title: title, Description: description, Project: issueNull(in.Project), Assignee: issueNull(in.Assignee), Priority: string(issuePriority(in.Priority)), ID: id,
	}); err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

func (is *issues) Remove(id string) error {
	if _, err := is.unsent(id); err != nil {
		return err
	}
	if err := is.q.RemoveIssue(context.Background(), id); err != nil {
		return err
	}
	is.core.Apply(protocol.FactIssueGone{ID: id})
	return nil
}

func (is *issues) Move(id, before string) ([]protocol.Issue, error) {
	if _, err := is.unsent(id); err != nil {
		return nil, err
	}
	all, err := is.List()
	if err != nil {
		return nil, err
	}
	order := []string{}
	for _, issue := range all {
		if len(issue.Sessions) == 0 && issue.ID != id {
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

func (is *issues) Queue(id string, queued bool) (protocol.Issue, error) {
	if _, err := is.unsent(id); err != nil {
		return protocol.Issue{}, err
	}
	ctx := context.Background()
	var err error
	if queued {
		err = is.q.QueueIssue(ctx, generated.QueueIssueParams{At: issueAt(clock.NowMs()), ID: id})
	} else {
		err = is.q.UnqueueIssue(ctx, id)
	}
	if err != nil {
		return protocol.Issue{}, err
	}
	is.publish(id)
	return is.Get(id)
}

// An issue not written down first (the manager sending someone at once, a playbook's step) is made from the session's job.
func (is *issues) Ran(id string, session protocol.Session) error {
	tx, err := is.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx, q := context.Background(), is.q.WithTx(tx)
	title, description := splitJob(session.Task)
	if err := q.OpenIssue(ctx, generated.OpenIssueParams{
		ID: id, Title: title, Description: description, Project: issueNull(session.Project), Assignee: issueNull(&session.Agent), CreatedAt: session.HiredAt,
	}); err != nil {
		return err
	}
	if err := q.AddSession(ctx, generated.AddSessionParams{Session: session.ID, Issue: id, StartedAt: session.HiredAt}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	is.publish(id)
	return nil
}

func (is *issues) family(ctx context.Context, q *generated.Queries, id string) ([]protocol.Issue, error) {
	rows, err := q.Family(ctx, id)
	if err != nil {
		return nil, err
	}
	all, err := q.SessionsOfFamily(ctx, id)
	if err != nil {
		return nil, err
	}
	runs := map[string][]string{}
	for _, r := range all {
		runs[r.Issue] = append(runs[r.Issue], r.Session)
	}
	state := is.core.State()
	out := make([]protocol.Issue, 0, len(rows))
	for _, row := range rows {
		out = append(out, issueOf(row, runs[row.ID], state))
	}
	return out, nil
}

// The caller commits.
func putFamily(ctx context.Context, q *generated.Queries, issues, before []protocol.Issue) ([]string, error) {
	for _, t := range issues {
		params := generated.PutIssueParams{
			ID: t.ID, Title: t.Title, Description: t.Description, Project: issueNull(t.Project), Assignee: issueNull(t.Assignee),
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

// The steps first, so that the playbook is whole when its parent issue changes.
func (is *issues) PutPlaybook(pb protocol.Playbook) error {
	ctx := context.Background()
	before, err := is.family(ctx, is.q, pb.ID)
	if err != nil {
		return err
	}
	issues := protocol.PlaybookIssues(pb, before, clock.NowMs())
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
		is.core.Apply(protocol.FactIssueGone{ID: id})
	}
	for _, t := range append(issues[1:], issues[0]) {
		is.publish(t.ID)
	}
	return nil
}

func (is *issues) NextPlaybookID() (string, error) {
	ids, err := is.q.PlanIDs(context.Background())
	if err != nil {
		return "", err
	}
	return nextPlaybookID(ids), nil
}

func issueTitle(issue protocol.Issue) string { return str.Cut(issue.Title, 40) }

func issueWords(in protocol.IssueRequest) (string, string, error) {
	title, rest := splitJob(in.Title)
	if title == "" {
		return "", "", protocol.Refused{Reason: "工单没有标题"}
	}
	description := str.Trim(in.Description)
	if rest != "" {
		description = strings.TrimSpace(rest + "\n\n" + description)
	}
	return title, description, nil
}

func issuePriority(p *protocol.Priority) protocol.Priority {
	if p == nil {
		return protocol.PriorityMedium
	}
	return *p
}

func issueNull(s *string) sql.NullString {
	if s == nil || str.Trim(*s) == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: str.Trim(*s), Valid: true}
}

func issueAt(ms int64) sql.NullInt64 { return sql.NullInt64{Int64: ms, Valid: true} }

func issueSchedule(id *string) sql.NullString {
	if id == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *id, Valid: true}
}

func issueClosed(how *protocol.IssueClose) sql.NullString {
	if how == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: string(*how), Valid: true}
}

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
