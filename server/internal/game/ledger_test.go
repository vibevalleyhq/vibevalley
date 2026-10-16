package game

import (
	"context"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// The ledger, a playbook's history, schedules and the heartbeat as services (ported from the parts of the TypeScript server's test/crew,
// foreman and playbooks tests about them): entries fold into the progress and back after a restart, facts tell of
// entries, coins carry once; schedules come due on their channel, once, late when missed, and keep through a restart;
// the heartbeat speaks of work left hanging once past its grace.

func planOpen(t *testing.T, home string) *world {
	t.Helper()
	f, err := newWorld(base.Config{Home: home, WorkRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func planKinds(t *testing.T, f *world) []string {
	t.Helper()
	rows, err := f.DB.Query("select kind from ledger order by seq")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		rows.Scan(&k)
		out = append(out, k)
	}
	return out
}

func TestPlanLedger(t *testing.T) {
	home := t.TempDir()
	f := planOpen(t, home)
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, events, stop := f.Site.Events()
	defer stop()

	agent := "lab"
	f.Ledger.Record(protocol.LedgerEntryHarvested{Helper: "w1", Agent: &agent, Project: "demo", Runtime: "pi", Commits: 1, Turns: 1})
	var news *protocol.ProgressNews
	for news == nil {
		select {
		case e := <-events:
			if p, ok := e.Value.(protocol.FactProgress); ok {
				news = p.News
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no progress fact")
		}
	}
	if news.Coins == nil || *news.Coins < 35 || planStr(news.Helper) != "w1" {
		t.Fatalf("news: %+v", news)
	}
	progress := f.Site.State().Progress
	if progress == nil || progress.Coins != *news.Coins || progress.Counts["harvests"] != 1 {
		t.Fatalf("progress: %+v", progress)
	}

	// The farm's facts tell of entries: a hire, a failed turn, a level reached.
	f.Site.Apply(protocol.FactHired{Helper: protocol.Helper{ID: "w2", Name: "帮工", Agent: "lab", Runtime: "pi", Task: "试试", Phase: protocol.Phase{Value: protocol.PhaseWorking{}}}})
	f.Site.Apply(protocol.FactReport{ID: "w2", Outcome: protocol.OutcomeFailed, Summary: "坏了", Turns: 1})
	f.Site.Apply(protocol.FactCommits{Commits: protocol.CommitCount{Total: 1000}})
	want := []string{"harvested", "hired", "failed", "level"}
	for deadline := time.Now().Add(5 * time.Second); !reflect.DeepEqual(planKinds(t, f), want); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("ledger: %v", planKinds(t, f))
		}
	}

	if !f.Ledger.Carry(120) || f.Ledger.Carry(50) || f.Ledger.Carry(0) {
		t.Fatal("coins carry once")
	}
	before := *f.Site.State().Progress
	f.Close()

	again := planOpen(t, home)
	defer again.Close()
	if after := again.Site.State().Progress; after == nil || !reflect.DeepEqual(*after, before) {
		t.Fatalf("the ledger folds back to the same progress:\n%+v\n%+v", after, before)
	}
	// A level reached before the ledger knew of it is caught up at start, once.
	if err := again.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if kinds := planKinds(t, again); kinds[len(kinds)-1] != "carried" {
		t.Fatalf("no catch-up for a level already on the ledger: %v", kinds)
	}
}

func TestPlanPlaybookLog(t *testing.T) {
	f := planOpen(t, t.TempDir())
	defer f.Close()
	pb := protocol.Playbook{ID: "p1", Title: "打卡", Goal: "做打卡", Project: "demo", State: protocol.PlaybookStatePlanning, Parallel: 3}
	f.PlaybookLog.Record(nil, pb, protocol.PlaybookActorUser, "")
	next := pb
	next.State = protocol.PlaybookStateAbandoned
	f.PlaybookLog.Record(&pb, next, protocol.PlaybookActorFarm, "重启了")
	// A row this code no longer reads is left out.
	if _, err := f.DB.Exec("insert into playbook_events (playbook_id, kind, actor, created_at) values ('p1', 'gone', 'farm', 1)"); err != nil {
		t.Fatal(err)
	}
	events := f.PlaybookLog.List("p1")
	if len(events) != 2 {
		t.Fatalf("events: %+v", events)
	}
	if events[0].Kind != protocol.PlaybookEventKindPlanning || events[0].Actor != protocol.PlaybookActorUser || planStr(events[0].Detail) != "做打卡" {
		t.Fatalf("first: %+v", events[0])
	}
	if events[1].Kind != protocol.PlaybookEventKindAbandoned || planStr(events[1].Detail) != "重启了" || events[1].Seq <= events[0].Seq {
		t.Fatalf("second: %+v", events[1])
	}
	if len(f.PlaybookLog.List("p2")) != 0 {
		t.Fatal("another playbook's history")
	}
}

func TestPlanSchedules(t *testing.T) {
	home := t.TempDir()
	f := planOpen(t, home)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 13, 8, 0, 0, 0, time.UTC).UnixMilli())
	f.Schedules.Now = clock.Load
	due, stopDue := f.Schedules.Due().Subscribe()
	defer stopDue()
	square := f.Chat.Square()

	made, err := f.Schedules.Add(protocol.ScheduleRequest{Name: " 看进度 ", Text: "看看帮工们的进度", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.Load() + 150}}})
	if err != nil {
		t.Fatal(err)
	}
	if made.Channel != square || made.Name != "看进度" || !made.Enabled || made.TZ == "" {
		t.Fatalf("made: %+v", made)
	}
	if got := f.Site.State().Schedules; len(got) != 1 || got[0].ID != made.ID {
		t.Fatalf("state: %+v", got)
	}
	f.Schedules.Tick()
	select {
	case d := <-due:
		t.Fatalf("not due yet: %+v", d)
	case <-time.After(50 * time.Millisecond):
	}
	clock.Add(200)
	f.Schedules.Tick()
	select {
	case d := <-due:
		if d.Schedule.ID != made.ID || d.Missed || d.Schedule.Enabled {
			t.Fatalf("due: %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never came due")
	}
	history, err := f.Chat.History(square, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if last := history[len(history)-1]; last.Kind != protocol.MessageKindNotice || last.Text != "⏰ 定时「看进度」到点了：看看帮工们的进度" {
		t.Fatalf("notice: %+v", last)
	}
	// A once is done after it ran.
	if f.Schedules.List()[0].Enabled {
		t.Fatal("a once is done after it ran")
	}
	f.Schedules.Tick()

	// Naming a helper wants a project; one nobody has is refused.
	lab := "lab"
	if _, err := f.Schedules.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}); err == nil || !strings.Contains(err.Error(), "默认项目") {
		t.Fatal(err)
	}
	nobody := "nobody"
	if _, err := f.Schedules.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Agent: &nobody, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}); err == nil || !strings.Contains(err.Error(), "没有叫 nobody") {
		t.Fatal(err)
	}
	var elsewhere int64 = 999
	if _, err := f.Schedules.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Channel: &elsewhere, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}); err == nil || !strings.Contains(err.Error(), "999") {
		t.Fatal(err)
	}
	project := "demo"
	every, err := f.Schedules.Add(protocol.ScheduleRequest{Name: "巡检", Text: "跑一遍检查", Agent: &lab, Project: &project, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}})
	if err != nil || planStr(every.Agent) != "lab" || planStr(every.Project) != "demo" {
		t.Fatal(every, err)
	}
	if _, err := f.Schedules.SetEnabled(every.ID, false); err != nil {
		t.Fatal(err)
	}
	f.Close()

	// Back after a restart, and switched on again: it counts from now, not from runs it skipped while off.
	f = planOpen(t, home)
	defer f.Close()
	f.Schedules.Now = clock.Load
	due, stopDue = f.Schedules.Due().Subscribe()
	defer stopDue()
	if got := f.Site.State().Schedules; len(got) != 2 || got[1].Enabled || planStr(got[1].Agent) != "lab" {
		t.Fatalf("after a restart: %+v", got)
	}
	clock.Add(60 * 60_000)
	on, err := f.Schedules.SetEnabled(every.ID, true)
	if err != nil || on.LastRun == nil || *on.LastRun != clock.Load() {
		t.Fatal(on, err)
	}
	f.Schedules.Tick()
	// The server was off past a run: it runs once, late, and says so.
	clock.Add(60 * 60_000)
	f.Schedules.Tick()
	select {
	case d := <-due:
		if d.Schedule.ID != every.ID || !d.Missed {
			t.Fatalf("due: %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never came due")
	}
	select {
	case d := <-due:
		t.Fatalf("once for all the runs it missed: %+v", d)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := f.Schedules.Remove(every.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Schedules.Remove(every.ID); err == nil {
		t.Fatal("removed twice")
	}
	if got := f.Site.State().Schedules; len(got) != 1 {
		t.Fatalf("unscheduled: %+v", got)
	}
}

func TestPlanHeartbeat(t *testing.T) {
	f := planOpen(t, t.TempDir())
	defer f.Close()
	news, stop := f.Heartbeat.News().Subscribe()
	defer stop()
	start := base.NowMs()
	var clock atomic.Int64
	clock.Store(start)
	f.Heartbeat.Now = clock.Load

	// Work done and left.
	f.Site.Apply(protocol.FactHired{Helper: protocol.Helper{ID: "w7", Name: "实验员", Agent: "lab", Runtime: "pi", Task: "加个 CHANGELOG", HiredAt: start, Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: start}}}})
	f.Site.Apply(protocol.FactReport{ID: "w7", Outcome: protocol.OutcomeCompleted, Summary: "加好了", Turns: 1})
	quiet := func(why string) {
		t.Helper()
		select {
		case n := <-news:
			t.Fatalf("%s: %+v", why, n)
		case <-time.After(50 * time.Millisecond):
		}
	}
	f.Heartbeat.Round()
	quiet("not yet past its grace")
	clock.Add(3 * 3_600_000)
	f.Heartbeat.Round()
	select {
	case n := <-news:
		if n.Channel != f.Chat.Square() || !strings.HasPrefix(n.Text, "【巡查】#田头 里有几件事放着没人管：\n") ||
			!strings.Contains(n.Text, "实验员（w7）的活做完 3 小时了还没收：「加个 CHANGELOG」") {
			t.Fatalf("news: %+v", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no news")
	}
	clock.Add(3_600_000 / 2)
	f.Heartbeat.Round()
	quiet("reported once")
}

func planStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
