package protocol

// Schedules (packages/protocol/src/schedules.ts): things said in a channel at set times ("every morning at nine, run
// the tests in #clock-in"). Times are written as people say them (once, every so many minutes, daily, some weekdays),
// never as cron; daily and weekly are in the schedule's time zone. A run missed while the server was off happens once
// when it is back, not once per miss. The next run is found as Effect's Cron.next finds it: the first matching minute
// strictly after the last run, a wall time skipped by a clock change taken as the same time before the change (02:30
// on a spring-forward night is 03:30), a repeated one as its first occurrence.

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MinEveryMinutes is the shortest interval, in minutes.
const MinEveryMinutes = 1

// MissedAfterMS: a run later than this after it was due was missed (the server was off), and says so.
const MissedAfterMS = 5 * 60_000

var scheduleTime = regexp.MustCompile(`^([01]?\d|2[0-3]):([0-5]\d)$`)

var Weekdays = [7]string{"日", "一", "二", "三", "四", "五", "六"}

var (
	scheduleCronZones sync.Map // string → *time.Location, or nil when not a zone
	scheduleIntlZones sync.Map
)

var (
	scheduleCronOffset = regexp.MustCompile(`([+-])(\d{2}):(\d{2})$`)
	scheduleIntlOffset = regexp.MustCompile(`^([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$`)
)

func scheduleFixed(tz, sign, hours, minutes string) *time.Location {
	h, _ := strconv.Atoi(hours)
	m, _ := strconv.Atoi(minutes)
	offset := (h*60 + m) * 60
	if sign == "-" {
		offset = -offset
	}
	return time.FixedZone(tz, offset)
}

func scheduleNamed(tz string) *time.Location {
	if tz == "" || tz == "Local" {
		return nil
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil
	}
	return loc
}

// scheduleCronZone is a time zone as Effect's Cron reads it: an offset when it starts with GMT, + or - (GMT+08:00,
// +08:00), else an IANA name; nil when it is neither.
func scheduleCronZone(tz string) *time.Location {
	if v, ok := scheduleCronZones.Load(tz); ok {
		return v.(*time.Location)
	}
	var loc *time.Location
	if strings.HasPrefix(tz, "GMT") || strings.HasPrefix(tz, "+") || strings.HasPrefix(tz, "-") {
		if m := scheduleCronOffset.FindStringSubmatch(tz); m != nil {
			loc = scheduleFixed(tz, m[1], m[2], m[3])
		}
	} else {
		loc = scheduleNamed(tz)
	}
	scheduleCronZones.Store(tz, loc)
	return loc
}

// scheduleIntlZone is a time zone as Intl.DateTimeFormat reads it: an IANA name, or an offset (+08:00, +0800, +08);
// nil when it is neither. Names are matched as Go's zone database matches them, not case-blind as Intl does.
func scheduleIntlZone(tz string) *time.Location {
	if v, ok := scheduleIntlZones.Load(tz); ok {
		return v.(*time.Location)
	}
	var loc *time.Location
	if m := scheduleIntlOffset.FindStringSubmatch(tz); m != nil {
		loc = scheduleFixed(tz, m[1], m[2], m[3])
	} else if !strings.HasPrefix(tz, "+") && !strings.HasPrefix(tz, "-") {
		loc = scheduleNamed(tz)
	}
	scheduleIntlZones.Store(tz, loc)
	return loc
}

// ScheduleProblem is why a schedule cannot be made as asked; "" when it can.
func ScheduleProblem(req ScheduleRequest, now int64) string {
	if coreTrim(req.Name) == "" {
		return "定时要有个名字"
	}
	if coreTrim(req.Text) == "" {
		return "定时要写到点了做什么"
	}
	if req.TZ != nil && scheduleIntlZone(*req.TZ) == nil {
		return "不认识这个时区：" + *req.TZ
	}
	switch w := req.When.Value.(type) {
	case ScheduleWhenOnce:
		if w.At > now {
			return ""
		}
		return "一次性的时间要在以后"
	case ScheduleWhenEvery:
		if w.Minutes >= MinEveryMinutes {
			return ""
		}
		return fmt.Sprintf("间隔至少 %d 分钟", MinEveryMinutes)
	case ScheduleWhenDaily:
		if scheduleTime.MatchString(w.Time) {
			return ""
		}
		return "时间写成 HH:MM，比如 09:00：" + w.Time
	case ScheduleWhenWeekly:
		if !scheduleTime.MatchString(w.Time) {
			return "时间写成 HH:MM，比如 09:00：" + w.Time
		}
		if len(w.Days) > 0 && !slices.ContainsFunc(w.Days, func(d int64) bool { return d < 0 || d > 6 }) {
			return ""
		}
		return "每周的哪几天：0 到 6，0 是周日"
	}
	return "不认识这种定时"
}

// scheduleNext is the first time of day hh:mm on one of days (any day when empty) in loc after from: later on the
// wall clock than from was, and later in time. Cron walks the wall clock, so a time the clock skipped just before from
// is behind it, though the time it stands for (moved on by the gap) is not.
func scheduleNext(from int64, hour, minute int, days []int64, loc *time.Location) (int64, bool) {
	start := time.UnixMilli(from).In(loc)
	y, m, d := start.Date()
	startWall := time.Date(y, m, d, start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), time.UTC).UnixMilli()
	for i := 0; i < 400; i++ {
		day := time.Date(y, m, d+i, hour, minute, 0, 0, time.UTC)
		if len(days) > 0 && !slices.Contains(days, int64(day.Weekday())) {
			continue
		}
		if day.UnixMilli() <= startWall {
			continue
		}
		if at := scheduleWallTime(day.Year(), day.Month(), day.Day(), hour, minute, loc); at > from {
			return at, true
		}
	}
	return 0, false
}

// scheduleWallTime is the instant a wall time names in loc, in ms: the earlier of two when the clock went back over
// it, the time before the change moved on by the gap when the clock skipped it.
func scheduleWallTime(y int, mo time.Month, d, h, mi int, loc *time.Location) int64 {
	wall := time.Date(y, mo, d, h, mi, 0, 0, time.UTC).Unix()
	_, before := time.Unix(wall-86_400, 0).In(loc).Zone()
	_, after := time.Unix(wall+86_400, 0).In(loc).Zone()
	var found []int64
	for _, offset := range []int{before, after} {
		at := wall - int64(offset)
		if _, o := time.Unix(at, 0).In(loc).Zone(); o == offset {
			found = append(found, at)
		}
	}
	if len(found) == 0 {
		return (wall - int64(before)) * 1000
	}
	return slices.Min(found) * 1000
}

// NextRun is when it is next due, counting from its last run (or its making); false when it is off or done.
func NextRun(s FarmSchedule) (int64, bool) {
	if !s.Enabled {
		return 0, false
	}
	from := s.Created
	if s.LastRun != nil {
		from = *s.LastRun
	}
	switch w := s.When.Value.(type) {
	case ScheduleWhenOnce:
		if s.LastRun == nil {
			return w.At, true
		}
		return 0, false
	case ScheduleWhenEvery:
		// A fraction of a millisecond is due at the next whole one.
		return int64(math.Ceil(float64(from) + w.Minutes*60_000)), true
	case ScheduleWhenDaily:
		return scheduleCron(from, w.Time, nil, s.TZ)
	case ScheduleWhenWeekly:
		days := w.Days
		if len(days) == 0 {
			days = nil
		}
		return scheduleCron(from, w.Time, days, s.TZ)
	}
	return 0, false
}

func scheduleCron(from int64, at string, days []int64, tz string) (int64, bool) {
	m := scheduleTime.FindStringSubmatch(at)
	loc := scheduleCronZone(tz)
	if m == nil || loc == nil {
		return 0, false
	}
	for _, d := range days {
		// Cron reads only 0 to 6 (7 is Sunday again); anything else is no cron.
		if d < 0 || d > 7 {
			return 0, false
		}
	}
	norm := make([]int64, len(days))
	for i, d := range days {
		norm[i] = d % 7
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	return scheduleNext(from, h, mi, norm, loc)
}

// DueSchedules is the schedules due at now, each once however many runs it missed.
func DueSchedules(all []FarmSchedule, now int64) []FarmSchedule {
	out := []FarmSchedule{}
	for _, s := range all {
		if next, ok := NextRun(s); ok && next <= now {
			out = append(out, s)
		}
	}
	return out
}

// IsMissed is whether this run is a late one, for a run missed while the server was off.
func IsMissed(s FarmSchedule, now int64) bool {
	next, ok := NextRun(s)
	if !ok {
		next = now
	}
	return now-next > MissedAfterMS
}

// AfterRun is a schedule after it ran at now: a once is done, the rest count on from now.
func AfterRun(s FarmSchedule, now int64) FarmSchedule {
	s.LastRun = &now
	if _, ok := s.When.Value.(ScheduleWhenOnce); ok {
		s.Enabled = false
	}
	return s
}

// scheduleClock is a moment as zh-CN's Intl writes month, day, hour and minute: 10/13 09:00. A zone that is none is
// read as UTC (JavaScript throws).
func scheduleClock(at int64, tz string) string {
	loc := scheduleIntlZone(tz)
	if loc == nil {
		loc = time.UTC
	}
	t := time.UnixMilli(at).In(loc)
	return fmt.Sprintf("%d/%d %02d:%02d", t.Month(), t.Day(), t.Hour(), t.Minute())
}

// WhenText is when, in words: 「每天 09:00」「每周一、三 09:00」「每 30 分钟」「10/13 09:00 一次」.
func WhenText(when ScheduleWhen, tz string) string {
	switch w := when.Value.(type) {
	case ScheduleWhenOnce:
		return scheduleClock(w.At, tz) + " 一次"
	case ScheduleWhenEvery:
		if math.Mod(w.Minutes, 60) == 0 {
			return "每 " + playbookNumberText(w.Minutes/60) + " 小时"
		}
		return "每 " + playbookNumberText(w.Minutes) + " 分钟"
	case ScheduleWhenDaily:
		return "每天 " + w.Time
	case ScheduleWhenWeekly:
		days := slices.Clone(w.Days)
		slices.Sort(days)
		days = slices.Compact(days)
		names := make([]string, len(days))
		for i, d := range days {
			if d >= 0 && d < 7 {
				names[i] = Weekdays[d]
			} else {
				names[i] = strconv.FormatInt(d, 10)
			}
		}
		return "每周" + strings.Join(names, "、") + " " + w.Time
	}
	return ""
}

// NextText is the next run in words, or why there is none.
func NextText(s FarmSchedule) string {
	if next, ok := NextRun(s); ok {
		return scheduleClock(next, s.TZ)
	}
	if s.Enabled {
		return "不会再到点"
	}
	if _, once := s.When.Value.(ScheduleWhenOnce); once && s.LastRun != nil {
		return "做过了"
	}
	return "关着"
}

// DueText is what is said in its channel when it comes due.
func DueText(s FarmSchedule, missed bool) string {
	late := ""
	if missed {
		late = "（服务端没开着时错过的，补一次）"
	}
	return "⏰ 定时「" + s.Name + "」到点了" + late + "：" + s.Text
}
