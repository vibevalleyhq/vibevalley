package protocol

import (
	"regexp"
	"testing"
	"time"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

const scheduleSH = "Asia/Shanghai"

func scheduleAt(iso string) int64 {
	t, err := time.Parse(time.RFC3339, iso+"+08:00")
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

func scheduleMake(change ...func(*Schedule)) Schedule {
	s := Schedule{ID: 1, Name: "测试", Text: "跑一遍测试", Channel: 1, When: ScheduleWhen{ScheduleWhenDaily{Time: "09:00"}}, TZ: scheduleSH, Enabled: true, Created: scheduleAt("2026-10-12T08:00:00")}
	for _, c := range change {
		c(&s)
	}
	return s
}

func scheduleNextOf(t *testing.T, s Schedule) int64 {
	t.Helper()
	next, ok := NextRun(s)
	if !ok {
		t.Fatal("no next run")
	}
	return next
}

func TestScheduleDailyWeekly(t *testing.T) {
	testkit.Eq(t, scheduleNextOf(t, scheduleMake()), scheduleAt("2026-10-12T09:00:00"))
	testkit.Eq(t, scheduleNextOf(t, scheduleMake(func(s *Schedule) { s.LastRun = ptr.To(scheduleAt("2026-10-12T09:00:00")) })), scheduleAt("2026-10-13T09:00:00"))
	testkit.Eq(t, scheduleNextOf(t, scheduleMake(func(s *Schedule) { s.TZ = "UTC" })), time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC).UnixMilli())
	testkit.Eq(t, scheduleNextOf(t, scheduleMake(func(s *Schedule) { s.When = ScheduleWhen{ScheduleWhenWeekly{Days: []int64{5, 3}, Time: "18:30"}} })), scheduleAt("2026-10-14T18:30:00"))
	testkit.Eq(t, scheduleNextOf(t, scheduleMake(func(s *Schedule) { s.When = ScheduleWhen{ScheduleWhenWeekly{Days: []int64{0}, Time: "07:00"}} })), scheduleAt("2026-10-18T07:00:00"))
}

func TestScheduleEveryOnce(t *testing.T) {
	every := ScheduleWhen{ScheduleWhenEvery{Minutes: 30}}
	testkit.Eq(t, scheduleNextOf(t, scheduleMake(func(s *Schedule) { s.When = every })), scheduleAt("2026-10-12T08:30:00"))
	testkit.Eq(t, scheduleNextOf(t, scheduleMake(func(s *Schedule) { s.When = every; s.LastRun = ptr.To(scheduleAt("2026-10-12T10:00:00")) })), scheduleAt("2026-10-12T10:30:00"))
	once := scheduleMake(func(s *Schedule) { s.When = ScheduleWhen{ScheduleWhenOnce{At: scheduleAt("2026-10-12T12:00:00")}} })
	testkit.Eq(t, scheduleNextOf(t, once), scheduleAt("2026-10-12T12:00:00"))
	done := once
	done.LastRun, done.Enabled = ptr.To(scheduleAt("2026-10-12T12:00:05")), false
	if _, ok := NextRun(done); ok {
		t.Fatal("done")
	}
	testkit.Eq(t, NextText(done), "做过了")
	if _, ok := NextRun(scheduleMake(func(s *Schedule) { s.Enabled = false })); ok {
		t.Fatal("one switched off is never due")
	}
}

func TestScheduleProblem(t *testing.T) {
	now := scheduleAt("2026-10-12T08:00:00")
	req := func(change ...func(*ScheduleRequest)) ScheduleRequest {
		r := ScheduleRequest{Name: "测试", Text: "跑测试", When: ScheduleWhen{ScheduleWhenDaily{Time: "09:00"}}}
		for _, c := range change {
			c(&r)
		}
		return r
	}
	when := func(w ScheduleWhenValue) func(*ScheduleRequest) {
		return func(r *ScheduleRequest) { r.When = ScheduleWhen{w} }
	}
	match := func(r ScheduleRequest, pattern string) {
		t.Helper()
		if p := ScheduleProblem(r, now); !regexp.MustCompile(pattern).MatchString(p) {
			t.Fatalf("%q does not match %s", p, pattern)
		}
	}
	testkit.Eq(t, ScheduleProblem(req(), now), "")
	match(req(when(ScheduleWhenDaily{Time: "9点"})), `HH:MM`)
	match(req(when(ScheduleWhenOnce{At: now - 1})), `以后`)
	match(req(when(ScheduleWhenEvery{Minutes: 0.2})), `至少`)
	match(req(when(ScheduleWhenWeekly{Days: []int64{7}, Time: "09:00"})), `0 到 6`)
	match(req(func(r *ScheduleRequest) { r.TZ = ptr.To("Mars/Base") }), `时区`)
	match(req(func(r *ScheduleRequest) { r.Text = " " }), `做什么`)
	testkit.Eq(t, ScheduleProblem(req(func(r *ScheduleRequest) { r.TZ = ptr.To("+08:00") }), now), "")
	match(req(func(r *ScheduleRequest) { r.TZ = ptr.To("Local") }), `时区`)
}

func TestWhenText(t *testing.T) {
	testkit.Eq(t, WhenText(ScheduleWhen{ScheduleWhenDaily{Time: "09:00"}}, scheduleSH), "每天 09:00")
	testkit.Eq(t, WhenText(ScheduleWhen{ScheduleWhenWeekly{Days: []int64{3, 1}, Time: "09:00"}}, scheduleSH), "每周一、三 09:00")
	testkit.Eq(t, WhenText(ScheduleWhen{ScheduleWhenEvery{Minutes: 120}}, scheduleSH), "每 2 小时")
	testkit.Eq(t, WhenText(ScheduleWhen{ScheduleWhenEvery{Minutes: 45}}, scheduleSH), "每 45 分钟")
	testkit.Eq(t, WhenText(ScheduleWhen{ScheduleWhenOnce{At: scheduleAt("2026-01-06T00:03:00")}}, scheduleSH), "1/6 00:03 一次")
}

func TestReduceKeepsSchedules(t *testing.T) {
	s := scheduleMake()
	one, _ := Reduce(EmptyCoreState(), Fact{FactSchedule{Schedule: s}})
	testkit.Eq(t, one.Schedules, []Schedule{s}, "the facts only")
	words := s
	words.WhenText, words.NextText = "每天 09:00", "10/12 09:00"
	testkit.Eq(t, FrameOf(one, nil).State.Schedules, []Schedule{words}, "the words are the frame's")
	if _, changed := Reduce(one, Fact{FactSchedule{Schedule: s}}); changed {
		t.Fatal("the same again is no news")
	}
	off := s
	off.Enabled = false
	offState, _ := Reduce(one, Fact{FactSchedule{Schedule: off}})
	testkit.Eq(t, offState.Schedules[0].Enabled, false)
	testkit.Eq(t, FrameOf(offState, nil).State.Schedules[0].NextText, "关着")
	gone, _ := Reduce(offState, Fact{FactUnschedule{ID: 1}})
	testkit.Eq(t, gone.Schedules, []Schedule{})
	if _, changed := Reduce(EmptyCoreState(), Fact{FactUnschedule{ID: 9}}); changed {
		t.Fatal("unschedule of none")
	}
}
