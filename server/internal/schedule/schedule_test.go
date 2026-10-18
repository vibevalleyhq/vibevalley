package schedule

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/ptr"
)

func TestSchedules(t *testing.T) {
	home := t.TempDir()
	f := open(t, home)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 13, 8, 0, 0, 0, time.UTC).UnixMilli())
	f.Schedule.Now = clock.Load
	due, stopDue := f.Schedule.Due().Subscribe()
	defer stopDue()
	general := f.Channel.General()

	made, err := f.Schedule.Add(protocol.ScheduleRequest{Name: " 看进度 ", Text: "看看帮工们的进度", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.Load() + 150}}}, protocol.ScheduleByOwner, true)
	if err != nil {
		t.Fatal(err)
	}
	if made.Channel != general || made.Name != "看进度" || !made.Enabled || made.TZ == "" {
		t.Fatalf("made: %+v", made)
	}
	if got := f.Core.State().Schedules; len(got) != 1 || got[0].ID != made.ID {
		t.Fatalf("state: %+v", got)
	}
	f.Schedule.Tick()
	select {
	case d := <-due:
		t.Fatalf("not due yet: %+v", d)
	case <-time.After(50 * time.Millisecond):
	}
	clock.Add(200)
	f.Schedule.Tick()
	select {
	case d := <-due:
		if d.Schedule.ID != made.ID || d.Missed || d.Schedule.Enabled {
			t.Fatalf("due: %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never came due")
	}
	history, err := f.Channel.History(general, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if last := history[len(history)-1]; last.Kind != protocol.MessageKindNotice || last.Text != "⏰ 定时「看进度」到点了：看看帮工们的进度" {
		t.Fatalf("notice: %+v", last)
	}
	if f.Schedule.List()[0].Enabled {
		t.Fatal("a once is done after it ran")
	}
	f.Schedule.Tick()

	lab := "lab"
	if _, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}, protocol.ScheduleByOwner, true); err == nil || !strings.Contains(err.Error(), "默认项目") {
		t.Fatal(err)
	}
	nobody := "nobody"
	if _, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Agent: &nobody, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}, protocol.ScheduleByOwner, true); err == nil || !strings.Contains(err.Error(), "没有叫 nobody") {
		t.Fatal(err)
	}
	elsewhere := "elsewhere"
	if _, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Channel: &elsewhere, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}, protocol.ScheduleByOwner, true); err == nil || !strings.Contains(err.Error(), "elsewhere") {
		t.Fatal(err)
	}
	project := "demo"
	every, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "巡检", Text: "跑一遍检查", Agent: &lab, Project: &project, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}, protocol.ScheduleByOwner, true)
	if err != nil || ptr.Value(every.Agent) != "lab" || ptr.Value(every.Project) != "demo" {
		t.Fatal(every, err)
	}
	if _, err := f.Schedule.SetEnabled(every.ID, false); err != nil {
		t.Fatal(err)
	}
	f.Close()

	f = open(t, home)
	defer f.Close()
	f.Schedule.Now = clock.Load
	due, stopDue = f.Schedule.Due().Subscribe()
	defer stopDue()
	if got := f.Core.State().Schedules; len(got) != 2 || got[1].Enabled || ptr.Value(got[1].Agent) != "lab" {
		t.Fatalf("after a restart: %+v", got)
	}
	clock.Add(60 * 60_000)
	on, err := f.Schedule.SetEnabled(every.ID, true)
	if err != nil || on.LastRun == nil || *on.LastRun != clock.Load() {
		t.Fatal(on, err)
	}
	f.Schedule.Tick()
	clock.Add(60 * 60_000)
	f.Schedule.Tick()
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
	if _, err := f.Schedule.Remove(every.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Schedule.Remove(every.ID); err == nil {
		t.Fatal("removed twice")
	}
	if got := f.Core.State().Schedules; len(got) != 1 {
		t.Fatalf("unscheduled: %+v", got)
	}
}
