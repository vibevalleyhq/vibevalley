package protocol

// The next run is the first matching minute strictly after the last run. A wall time skipped by a clock change is taken as the same time before
// the change (02:30 on a spring-forward night is 03:30); a repeated one is its first occurrence.

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/x/num"
	"vibevalley/pkg/x/str"
)

const MinEveryMinutes = 1

var scheduleTime = regexp.MustCompile(`^([01]?\d|2[0-3]):([0-5]\d)$`)

var Weekdays = [7]string{"日", "一", "二", "三", "四", "五", "六"}

var (
	scheduleRunZones   sync.Map // string → *time.Location, or nil when not a zone
	scheduleGivenZones sync.Map
)

var (
	scheduleRunOffset   = regexp.MustCompile(`([+-])(\d{2}):(\d{2})$`)
	scheduleGivenOffset = regexp.MustCompile(`^([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$`)
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

// The zone runs are counted in: an offset when it starts with GMT, + or - (GMT+08:00, +08:00), else an IANA name; nil when it is neither. It takes
// fewer offsets than scheduleGivenZone: not +0800 or +08.
func scheduleRunZone(tz string) *time.Location {
	if v, ok := scheduleRunZones.Load(tz); ok {
		return v.(*time.Location)
	}
	var loc *time.Location
	if strings.HasPrefix(tz, "GMT") || strings.HasPrefix(tz, "+") || strings.HasPrefix(tz, "-") {
		if m := scheduleRunOffset.FindStringSubmatch(tz); m != nil {
			loc = scheduleFixed(tz, m[1], m[2], m[3])
		}
	} else {
		loc = scheduleNamed(tz)
	}
	scheduleRunZones.Store(tz, loc)
	return loc
}

// The zone a schedule may be given and its times are written in: an IANA name, matched as Go's zone database matches it, or an offset (+08:00,
// +0800, +08); nil when it is neither.
func scheduleGivenZone(tz string) *time.Location {
	if v, ok := scheduleGivenZones.Load(tz); ok {
		return v.(*time.Location)
	}
	var loc *time.Location
	if m := scheduleGivenOffset.FindStringSubmatch(tz); m != nil {
		loc = scheduleFixed(tz, m[1], m[2], m[3])
	} else if !strings.HasPrefix(tz, "+") && !strings.HasPrefix(tz, "-") {
		loc = scheduleNamed(tz)
	}
	scheduleGivenZones.Store(tz, loc)
	return loc
}

func ScheduleProblem(req ScheduleRequest, now int64) string {
	if str.Trim(req.Name) == "" {
		return "定时要有个名字"
	}
	if str.Trim(req.Text) == "" {
		return "定时要写到点了做什么"
	}
	if req.TZ != nil && scheduleGivenZone(*req.TZ) == nil {
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
	case ScheduleWhenCron:
		return cronProblem(w.Expr, now, req.TZ)
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

func NextRun(s Schedule) (int64, bool) {
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
		// The conversion stops a fused multiply-add (arm64): the product is rounded first, as in JavaScript.
		return int64(math.Ceil(float64(from) + float64(w.Minutes*60_000))), true
	case ScheduleWhenDaily:
		return scheduleCron(from, w.Time, nil, s.TZ)
	case ScheduleWhenWeekly:
		days := w.Days
		if len(days) == 0 {
			days = nil
		}
		return scheduleCron(from, w.Time, days, s.TZ)
	case ScheduleWhenCron:
		return scheduleCronNext(from, w.Expr, s.TZ)
	}
	return 0, false
}

func scheduleCron(from int64, at string, days []int64, tz string) (int64, bool) {
	m := scheduleTime.FindStringSubmatch(at)
	loc := scheduleRunZone(tz)
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

// A zone that is none is read as UTC.
func scheduleClock(at int64, tz string) string {
	loc := scheduleGivenZone(tz)
	if loc == nil {
		loc = time.UTC
	}
	t := time.UnixMilli(at).In(loc)
	return fmt.Sprintf("%d/%d %02d:%02d", t.Month(), t.Day(), t.Hour(), t.Minute())
}

func WhenText(when ScheduleWhen, tz string) string {
	switch w := when.Value.(type) {
	case ScheduleWhenOnce:
		return scheduleClock(w.At, tz) + " 一次"
	case ScheduleWhenEvery:
		if math.Mod(w.Minutes, 60) == 0 {
			return "每 " + num.Text(w.Minutes/60) + " 小时"
		}
		return "每 " + num.Text(w.Minutes) + " 分钟"
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
	case ScheduleWhenCron:
		return cronText(w.Expr)
	}
	return ""
}

func NextText(s Schedule) string {
	if next, ok := NextRun(s); ok {
		return scheduleClock(next, s.TZ)
	}
	if s.Enabled {
		return "不会再到点"
	}
	if s.Pending {
		return "等主人同意"
	}
	if _, once := s.When.Value.(ScheduleWhenOnce); once && s.LastRun != nil {
		return "做过了"
	}
	return "关着"
}

func DueText(s Schedule, missed bool) string {
	late := ""
	if missed {
		late = "（服务端没开着时错过的，补一次）"
	}
	return "⏰ 定时「" + s.Name + "」到点了" + late + "：" + s.Text
}
