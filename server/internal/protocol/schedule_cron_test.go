package protocol

import (
	"regexp"
	"testing"
	"time"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func cronOf(expr string, change ...func(*Schedule)) Schedule {
	return scheduleMake(append([]func(*Schedule){func(s *Schedule) { s.When = ScheduleWhen{ScheduleWhenCron{Expr: expr}} }}, change...)...)
}

// Created Monday 2026-10-12 08:00 in Shanghai.
func TestScheduleCron(t *testing.T) {
	after := func(iso string) func(*Schedule) { return func(s *Schedule) { s.LastRun = ptr.To(scheduleAt(iso)) } }
	for _, c := range []struct {
		expr string
		last string
		want string
	}{
		{"0 9 * * 1-5", "", "2026-10-12T09:00:00"},
		{"0 9 * * 1-5", "2026-10-16T09:00:00", "2026-10-19T09:00:00"},
		{"15 * * * *", "", "2026-10-12T08:15:00"},
		{"*/20 8 * * *", "", "2026-10-12T08:20:00"},
		{"0 10 1 * *", "", "2026-11-01T10:00:00"},
		{"0 9 * * 7", "", "2026-10-18T09:00:00"},
		// Both day fields given: either one is due (the 13th is a Tuesday).
		{"0 9 13 * 5", "", "2026-10-13T09:00:00"},
		{"0 9 13 * 5", "2026-10-13T09:00:00", "2026-10-16T09:00:00"},
		{"0 0 29 2 *", "", "2028-02-29T00:00:00"},
		{"0,30 9-10 * * *", "2026-10-12T09:30:00", "2026-10-12T10:00:00"},
	} {
		var change []func(*Schedule)
		if c.last != "" {
			change = append(change, after(c.last))
		}
		got, ok := NextRun(cronOf(c.expr, change...))
		if !ok || got != scheduleAt(c.want) {
			t.Errorf("%s after %q: got %v, want %s", c.expr, c.last, time.UnixMilli(got).In(time.FixedZone("", 8*3600)), c.want)
		}
	}
}

// A cron the old kinds can say runs when they do, across clock changes too.
func TestScheduleCronLikeDaily(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	for _, tz := range []string{"America/New_York", scheduleSH} {
		for _, at := range []string{"02:30", "01:30", "00:00", "23:59"} {
			for _, from := range []time.Time{time.Date(2026, 3, 7, 12, 0, 0, 0, loc), time.Date(2026, 3, 8, 1, 59, 0, 0, loc), time.Date(2026, 10, 31, 23, 0, 0, 0, loc), time.Date(2026, 11, 1, 1, 30, 0, 0, loc)} {
				base := func(s *Schedule) { s.TZ = tz; s.Created = from.UnixMilli() }
				daily := scheduleNextOf(t, scheduleMake(base, func(s *Schedule) { s.When = ScheduleWhen{ScheduleWhenDaily{Time: at}} }))
				weekly := scheduleNextOf(t, scheduleMake(base, func(s *Schedule) { s.When = ScheduleWhen{ScheduleWhenWeekly{Days: []int64{0, 3}, Time: at}} }))
				expr := at[3:] + " " + at[:2]
				testkit.Eq(t, scheduleNextOf(t, cronOf(expr+" * * *", base)), daily, tz+" "+at+" daily")
				testkit.Eq(t, scheduleNextOf(t, cronOf(expr+" * * 0,3", base)), weekly, tz+" "+at+" weekly")
			}
		}
	}
}

func TestScheduleCronProblem(t *testing.T) {
	now := scheduleAt("2026-10-12T08:00:00")
	match := func(expr, pattern string) {
		t.Helper()
		p := ScheduleProblem(ScheduleRequest{Name: "n", Text: "t", When: ScheduleWhen{ScheduleWhenCron{Expr: expr}}, TZ: ptr.To(scheduleSH)}, now)
		if !regexp.MustCompile(pattern).MatchString(p) {
			t.Fatalf("%s: %q does not match %s", expr, p, pattern)
		}
	}
	match("0 9 * * 1-5", `^$`)
	match("*/5 * * * *", `^$`)
	match("0 9 * *", `五段`)
	match("60 * * * *", `分钟`)
	match("0 24 * * *", `小时`)
	match("0 9 0 * *", `日`)
	match("0 9 * 13 *", `月`)
	match("0 9 * * 8", `周几`)
	match("0 9 5-1 * *", `日`)
	match("*/0 * * * *", `分钟`)
	match("a b c d e", `分钟`)
	match("0 0 30 2 *", `永远`)
}

func TestCronText(t *testing.T) {
	for expr, want := range map[string]string{
		"0 9 * * *":     "每天 09:00",
		"0 9 * * 1-5":   "工作日 09:00",
		"0 10 * * 6,0":  "周末 10:00",
		"30 18 * * 3,1": "每周一、三 18:30",
		"0 7 * * 7":     "每周日 07:00",
		"0 10 1 * *":    "每月 1 号 10:00",
		"15 * * * *":    "每小时第 15 分",
		"*/5 * * * *":   "cron */5 * * * *",
		"0 9 1 1 *":     "cron 0 9 1 1 *",
		"bad":           "cron bad",
	} {
		testkit.Eq(t, WhenText(ScheduleWhen{ScheduleWhenCron{Expr: expr}}, scheduleSH), want, expr)
	}
}
