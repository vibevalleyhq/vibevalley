package protocol

import (
	"slices"
	"strconv"
	"strings"
	"time"
)

// A cron expression is the five fields minute, hour, day of month, month and day of week, each a comma list of *, n or a-b, any of them with
// /step. Day of week is 0 to 7, both 0 and 7 Sunday. As in Vixie cron, when neither day field starts with *, a day matching either one is
// due; otherwise it must match both.
type scheduleCronSpec struct {
	minute, hour, dom, month, dow uint64
	anyDom, anyDow                bool
}

// cronYears bounds the search for a next run: 29 February comes round within eight years.
const cronYears = 8

var cronFields = [5]struct {
	name     string
	min, max int
}{{"分钟", 0, 59}, {"小时", 0, 23}, {"日", 1, 31}, {"月", 1, 12}, {"周几", 0, 7}}

func cronField(field string, i int) (uint64, string) {
	lo, hi := cronFields[i].min, cronFields[i].max
	bad := "cron 的" + cronFields[i].name + "写错了：" + field
	var bits uint64
	for item := range strings.SplitSeq(field, ",") {
		span, stepText, stepped := strings.Cut(item, "/")
		step := 1
		if stepped {
			n, err := strconv.Atoi(stepText)
			if err != nil || n < 1 {
				return 0, bad
			}
			step = n
		}
		from, to := lo, hi
		if span != "*" {
			a, b, ranged := strings.Cut(span, "-")
			x, err := strconv.Atoi(a)
			if err != nil {
				return 0, bad
			}
			from, to = x, x
			if ranged {
				y, err := strconv.Atoi(b)
				if err != nil {
					return 0, bad
				}
				to = y
			} else if stepped {
				to = hi
			}
		}
		if from < lo || to > hi || from > to {
			return 0, bad
		}
		for v := from; v <= to; v += step {
			bits |= 1 << v
		}
	}
	return bits, ""
}

func parseScheduleCron(expr string) (scheduleCronSpec, string) {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return scheduleCronSpec{}, "cron 要五段：分 时 日 月 周几，比如 0 9 * * 1-5"
	}
	var bits [5]uint64
	for i, f := range fields {
		b, problem := cronField(f, i)
		if problem != "" {
			return scheduleCronSpec{}, problem
		}
		bits[i] = b
	}
	if bits[4]&(1<<7) != 0 {
		bits[4] = bits[4]&^(1<<7) | 1
	}
	return scheduleCronSpec{
		minute: bits[0], hour: bits[1], dom: bits[2], month: bits[3], dow: bits[4],
		anyDom: strings.HasPrefix(fields[2], "*"), anyDow: strings.HasPrefix(fields[4], "*"),
	}, ""
}

func (c scheduleCronSpec) onDay(day time.Time) bool {
	if c.month&(1<<int(day.Month())) == 0 {
		return false
	}
	dom, dow := c.dom&(1<<day.Day()) != 0, c.dow&(1<<int(day.Weekday())) != 0
	if c.anyDom || c.anyDow {
		return dom && dow
	}
	return dom || dow
}

// next walks the wall clock as scheduleNext does: the first matching minute later on the wall clock than from was, and later in time.
func (c scheduleCronSpec) next(from int64, loc *time.Location) (int64, bool) {
	start := time.UnixMilli(from).In(loc)
	y, m, d := start.Date()
	startWall := time.Date(y, m, d, start.Hour(), start.Minute(), start.Second(), start.Nanosecond(), time.UTC).UnixMilli()
	for i := 0; i < cronYears*366; i++ {
		day := time.Date(y, m, d+i, 0, 0, 0, 0, time.UTC)
		if !c.onDay(day) {
			continue
		}
		for h := 0; h < 24; h++ {
			if c.hour&(1<<h) == 0 {
				continue
			}
			for mi := 0; mi < 60; mi++ {
				if c.minute&(1<<mi) == 0 {
					continue
				}
				if day.Add(time.Duration(h)*time.Hour+time.Duration(mi)*time.Minute).UnixMilli() <= startWall {
					continue
				}
				if at := scheduleWallTime(day.Year(), day.Month(), day.Day(), h, mi, loc); at > from {
					return at, true
				}
			}
		}
	}
	return 0, false
}

func scheduleCronNext(from int64, expr, tz string) (int64, bool) {
	spec, problem := parseScheduleCron(expr)
	loc := scheduleRunZone(tz)
	if problem != "" || loc == nil {
		return 0, false
	}
	return spec.next(from, loc)
}

func cronProblem(expr string, now int64, tz *string) string {
	spec, problem := parseScheduleCron(expr)
	if problem != "" {
		return problem
	}
	loc := time.Local
	if tz != nil {
		loc = scheduleGivenZone(*tz)
	}
	if _, ok := spec.next(now, loc); !ok {
		return "这个 cron 永远不会到点：" + expr
	}
	return ""
}

// cronText says the common shapes in words and the rest as the expression itself.
func cronText(expr string) string {
	f := strings.Fields(expr)
	if _, problem := parseScheduleCron(expr); problem != "" {
		return "cron " + expr
	}
	number := func(s string) (int, bool) {
		n, err := strconv.Atoi(s)
		return n, err == nil
	}
	mi, minuteOK := number(f[0])
	h, hourOK := number(f[1])
	clock := ""
	if minuteOK && hourOK {
		clock = strconv.Itoa(100 + h)[1:] + ":" + strconv.Itoa(100 + mi)[1:]
	}
	switch {
	case clock != "" && f[2] == "*" && f[3] == "*":
		switch f[4] {
		case "*":
			return "每天 " + clock
		case "1-5":
			return "工作日 " + clock
		case "0,6", "6,0", "6,7", "6-7":
			return "周末 " + clock
		}
		days := []int64{}
		for d := range strings.SplitSeq(f[4], ",") {
			n, ok := number(d)
			if !ok {
				return "cron " + expr
			}
			days = append(days, int64(n%7))
		}
		slices.Sort(days)
		names := make([]string, 0, len(days))
		for _, d := range slices.Compact(days) {
			names = append(names, Weekdays[d])
		}
		return "每周" + strings.Join(names, "、") + " " + clock
	case clock != "" && f[3] == "*" && f[4] == "*":
		if d, ok := number(f[2]); ok {
			return "每月 " + strconv.Itoa(d) + " 号 " + clock
		}
	case minuteOK && f[1] == "*" && f[2] == "*" && f[3] == "*" && f[4] == "*":
		return "每小时第 " + strconv.Itoa(mi) + " 分"
	}
	return "cron " + expr
}
