package issue_test

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/schedule"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/db/generated"
)

func TestQueuedIssueKeepsOriginalDispatchChannel(t *testing.T) {
	f := lifecycleWorld(t)
	agent := fixture.Lab(t)
	if _, err := f.Agent.SaveAgent(agent); err != nil {
		t.Fatal(err)
	}
	first, err := f.Channel.OpenChannel("first", "", "demo")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.Channel.OpenChannel("second", "", "demo")
	if err != nil {
		t.Fatal(err)
	}
	project := "demo"
	f.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "occupied", Project: &project, Runtime: agent.Runtime, Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	issue, err := f.Issue.Add(protocol.IssueRequest{Title: "queued", Assignee: &agent.ID, Project: &project})
	if err != nil {
		t.Fatal(err)
	}
	for _, channel := range []string{first.ID, second.ID} {
		got, err := f.Issue.Start(context.Background(), issue.ID, channel)
		if err != nil || got.Queued == nil {
			t.Fatalf("queue: %+v %v", got, err)
		}
	}
	q := generated.New(f.DB)
	queued, err := q.QueuedIssue(context.Background(), issue.ID)
	if err != nil || queued.Channel != first.ID {
		t.Fatalf("persisted dispatch: %+v %v", queued, err)
	}
	f.Core.Apply(protocol.FactLeft{ID: "occupied"})
	started, err := f.Issue.Start(context.Background(), issue.ID, second.ID)
	if err != nil || started.Session == nil {
		t.Fatalf("queued direct retry: %+v %v", started, err)
	}
	got, err := f.Issue.Get(issue.ID)
	if err != nil || len(got.Sessions) != 1 {
		t.Fatalf("started: %+v %v", got, err)
	}
	s := f.Session.Get(got.Sessions[0])
	if s == nil || s.Channel == nil || *s.Channel != first.ID {
		t.Fatalf("lost channel: %+v", s)
	}
	run := testkit.Await(t, "queued run", func() (protocol.Run, bool) {
		runs, _ := f.Session.Runs(issue.ID)
		if len(runs) == 0 {
			return protocol.Run{}, false
		}
		return runs[0], true
	})
	if run.TriggeredBy.Kind != protocol.RunTriggerKindIssue {
		t.Fatalf("trigger: %+v", run.TriggeredBy)
	}
	if _, err := q.QueuedIssue(context.Background(), issue.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("dispatch context not removed: %v", err)
	}
}

func TestQueuedScheduleKeepsTriggerAndMissedFlag(t *testing.T) {
	f := lifecycleWorld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := f.Issue.OnStart(ctx); err != nil {
		t.Fatal(err)
	}
	defer f.Issue.OnStop()
	agent := fixture.Lab(t)
	if _, err := f.Agent.SaveAgent(agent); err != nil {
		t.Fatal(err)
	}
	channel, err := f.Channel.OpenChannel("scheduled", "", "demo")
	if err != nil {
		t.Fatal(err)
	}
	project := "demo"
	f.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "occupied", Project: &project, Runtime: agent.Runtime, Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	sc, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "scheduled", Text: "work", Channel: &channel.ID, Agent: &agent.ID, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 1}}}, protocol.ScheduleByOwner, true)
	if err != nil {
		t.Fatal(err)
	}
	f.Schedule.Due().Publish(schedule.Due{Schedule: sc, Missed: true})
	issue := testkit.Await(t, "schedule queued", func() (protocol.Issue, bool) { i, ok := f.Issue.OfSchedule(sc.ID); return i, ok && i.QueuedAt != nil })
	f.Core.Apply(protocol.FactLeft{ID: "occupied"})
	f.Issue.TryQueued(ctx)
	run := testkit.Await(t, "scheduled run", func() (protocol.Run, bool) {
		runs, _ := f.Session.Runs(issue.ID)
		if len(runs) == 0 {
			return protocol.Run{}, false
		}
		return runs[0], true
	})
	if run.TriggeredBy.Kind != protocol.RunTriggerKindSchedule || run.TriggeredBy.Schedule == nil || *run.TriggeredBy.Schedule != sc.ID || !run.TriggeredBy.Missed {
		t.Fatalf("lost schedule trigger: %+v", run.TriggeredBy)
	}
	got := f.Session.Get(run.Session)
	if got == nil || got.Channel == nil || *got.Channel != channel.ID {
		t.Fatalf("wrong channel: %+v", got)
	}
}

// The sowing form's 开工待办: a queued todo starts now when there is room, and keeps its place in the queue when there is none.
func TestAQueuedTodoStartsFromTheSowingForm(t *testing.T) {
	f := lifecycleWorld(t)
	agent := fixture.Lab(t)
	if _, err := f.Agent.SaveAgent(agent); err != nil {
		t.Fatal(err)
	}
	project := "demo"
	f.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "occupied", Project: &project, Runtime: agent.Runtime, Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	issue, err := f.Issue.Add(protocol.IssueRequest{Title: "queued", Assignee: &agent.ID, Project: &project})
	if err != nil {
		t.Fatal(err)
	}
	var refused protocol.Refused
	if _, err := f.Issue.StartQueued(context.Background(), issue.ID); !errors.As(err, &refused) {
		t.Fatalf("a backlog issue started: %v", err)
	}
	if got, err := f.Issue.Start(context.Background(), issue.ID, f.Channel.General()); err != nil || got.Queued == nil {
		t.Fatalf("queue: %+v %v", got, err)
	}
	queued, _ := f.Issue.Get(issue.ID)
	still, err := f.Issue.StartQueued(context.Background(), issue.ID)
	if err != nil || still.Queued == nil || still.Session != nil {
		t.Fatalf("no room: %+v %v", still, err)
	}
	if again, _ := f.Issue.Get(issue.ID); again.QueuedAt == nil || *again.QueuedAt != *queued.QueuedAt {
		t.Fatalf("lost its place: %v, was %v", again.QueuedAt, *queued.QueuedAt)
	}
	f.Core.Apply(protocol.FactLeft{ID: "occupied"})
	started, err := f.Issue.StartQueued(context.Background(), issue.ID)
	if err != nil || started.Session == nil {
		t.Fatalf("with room: %+v %v", started, err)
	}
}
