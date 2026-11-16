package issue

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const cronSearchDays = 366 * 9

var (
	hhmmPattern   = regexp.MustCompile(`^([01]?\d|2[0-3]):([0-5]\d)$`)
	offsetPattern = regexp.MustCompile(`^(?:GMT)?([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$`)
)

// ValidateCron checks that sched has valid schedule fields, timezone, and at least one future occurrence.
func ValidateCron(sched CronSchedule, nowMs int64) error {
	if strings.TrimSpace(sched.Name) == "" {
		return fmt.Errorf("%w: name is required", ErrInvalidCronSchedule)
	}
	if strings.TrimSpace(sched.Title) == "" && strings.TrimSpace(sched.Prompt) == "" {
		return fmt.Errorf("%w: title or prompt is required", ErrInvalidCronSchedule)
	}
	if _, err := resolveTimezone(sched.Timezone); err != nil {
		return err
	}
	switch sched.Kind {
	case CronOnce:
		if sched.AtMs <= nowMs {
			return fmt.Errorf("%w: once schedule atMs (%d) must be > now (%d)", ErrInvalidCronSchedule, sched.AtMs, nowMs)
		}
	case CronEvery:
		if sched.EveryMs <= 0 && sched.EveryMinutes < 1 {
			return fmt.Errorf("%w: every schedule requires everyMinutes >= 1 or everyMs > 0", ErrInvalidCronSchedule)
		}
	case CronDaily:
		if !hhmmPattern.MatchString(sched.TimeOfDay) {
			return fmt.Errorf("%w: invalid daily timeOfDay %q", ErrInvalidCronSchedule, sched.TimeOfDay)
		}
	case CronWeekly:
		if !hhmmPattern.MatchString(sched.TimeOfDay) {
			return fmt.Errorf("%w: invalid weekly timeOfDay %q", ErrInvalidCronSchedule, sched.TimeOfDay)
		}
		if len(sched.Weekdays) == 0 {
			return fmt.Errorf("%w: weekly schedule requires at least one weekday", ErrInvalidCronSchedule)
		}
		for _, d := range sched.Weekdays {
			if d < 0 || d > 7 {
				return fmt.Errorf("%w: invalid weekday %d", ErrInvalidCronSchedule, d)
			}
		}
	case CronExpr:
		spec, err := parseCronExpr(sched.Expr)
		if err != nil {
			return err
		}
		loc, _ := resolveTimezone(sched.Timezone)
		if _, ok := nextCronMatch(spec, loc, nowMs); !ok {
			return fmt.Errorf("%w: cron expression %q has no valid occurrence within 9 years", ErrInvalidCronSchedule, sched.Expr)
		}
	default:
		return fmt.Errorf("%w: unknown kind %q", ErrInvalidCronSchedule, sched.Kind)
	}
	return nil
}

// ComputeNextRun calculates the next scheduled timestamp strictly greater than afterMs.
// Returns 0 when a disabled or completed one-shot schedule has no further runs.
func ComputeNextRun(sched CronSchedule, afterMs int64) (int64, error) {
	if !sched.Enabled || sched.PendingApproval {
		return 0, nil
	}
	loc, err := resolveTimezone(sched.Timezone)
	if err != nil {
		return 0, err
	}

	switch sched.Kind {
	case CronOnce:
		if sched.LastRunAtMs > 0 {
			return 0, nil
		}
		return sched.AtMs, nil

	case CronEvery:
		stepMs := sched.EveryMs
		if stepMs <= 0 {
			stepMs = int64(sched.EveryMinutes) * 60_000
		}
		if stepMs <= 0 {
			return 0, fmt.Errorf("%w: invalid interval", ErrInvalidCronSchedule)
		}
		base := afterMs
		if base == 0 {
			base = sched.CreatedAtMs
		}
		return base + stepMs, nil

	case CronDaily:
		hour, minute, err := parseHHMM(sched.TimeOfDay)
		if err != nil {
			return 0, err
		}
		spec := parsedCron{
			minutes:  map[int]bool{minute: true},
			hours:    map[int]bool{hour: true},
			days:     nil,
			months:   nil,
			weekdays: nil,
			andDays:  true,
		}
		next, ok := nextCronMatch(spec, loc, afterMs)
		if !ok {
			return 0, fmt.Errorf("%w: daily schedule produced no next occurrence", ErrInvalidCronSchedule)
		}
		return next, nil

	case CronWeekly:
		hour, minute, err := parseHHMM(sched.TimeOfDay)
		if err != nil {
			return 0, err
		}
		dows := make(map[int]bool, len(sched.Weekdays))
		for _, d := range sched.Weekdays {
			dows[d%7] = true
		}
		spec := parsedCron{
			minutes:  map[int]bool{minute: true},
			hours:    map[int]bool{hour: true},
			days:     nil,
			months:   nil,
			weekdays: dows,
			andDays:  true,
		}
		next, ok := nextCronMatch(spec, loc, afterMs)
		if !ok {
			return 0, fmt.Errorf("%w: weekly schedule produced no next occurrence", ErrInvalidCronSchedule)
		}
		return next, nil

	case CronExpr:
		spec, err := parseCronExpr(sched.Expr)
		if err != nil {
			return 0, err
		}
		next, ok := nextCronMatch(spec, loc, afterMs)
		if !ok {
			return 0, fmt.Errorf("%w: cron expression %q produced no next occurrence", ErrInvalidCronSchedule, sched.Expr)
		}
		return next, nil

	default:
		return 0, fmt.Errorf("%w: unknown kind %q", ErrInvalidCronSchedule, sched.Kind)
	}
}

func resolveTimezone(tz string) (*time.Location, error) {
	tz = strings.TrimSpace(tz)
	if tz == "" || tz == "UTC" {
		return time.UTC, nil
	}
	if tz == "Local" {
		return time.Local, nil
	}
	if m := offsetPattern.FindStringSubmatch(tz); m != nil {
		sign := 1
		if m[1] == "-" {
			sign = -1
		}
		hours, _ := strconv.Atoi(m[2])
		mins := 0
		if m[3] != "" {
			mins, _ = strconv.Atoi(m[3])
		}
		offsetSec := sign * (hours*3600 + mins*60)
		return time.FixedZone(tz, offsetSec), nil
	}
	if strings.HasPrefix(tz, "+") || strings.HasPrefix(tz, "-") {
		return nil, fmt.Errorf("%w: invalid timezone offset %q", ErrInvalidCronSchedule, tz)
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("%w: unknown timezone %q: %v", ErrInvalidCronSchedule, tz, err)
	}
	return loc, nil
}

func parseHHMM(s string) (int, int, error) {
	m := hhmmPattern.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, 0, fmt.Errorf("%w: invalid HH:MM %q", ErrInvalidCronSchedule, s)
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	return h, mi, nil
}

type parsedCron struct {
	minutes  map[int]bool
	hours    map[int]bool
	days     map[int]bool
	months   map[int]bool
	weekdays map[int]bool
	andDays  bool
}

var cronFieldBounds = [5]struct {
	min int
	max int
}{
	{0, 59}, // minute
	{0, 23}, // hour
	{1, 31}, // day of month
	{1, 12}, // month
	{0, 7},  // day of week (0 & 7 = Sunday)
}

func parseCronExpr(expr string) (parsedCron, error) {
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return parsedCron{}, fmt.Errorf("%w: cron expression must have 5 fields, got %d", ErrInvalidCronSchedule, len(parts))
	}
	mins, err := parseCronField(parts[0], cronFieldBounds[0].min, cronFieldBounds[0].max, false)
	if err != nil {
		return parsedCron{}, err
	}
	hrs, err := parseCronField(parts[1], cronFieldBounds[1].min, cronFieldBounds[1].max, false)
	if err != nil {
		return parsedCron{}, err
	}
	days, err := parseCronField(parts[2], cronFieldBounds[2].min, cronFieldBounds[2].max, true)
	if err != nil {
		return parsedCron{}, err
	}
	months, err := parseCronField(parts[3], cronFieldBounds[3].min, cronFieldBounds[3].max, true)
	if err != nil {
		return parsedCron{}, err
	}
	dows, err := parseCronField(parts[4], cronFieldBounds[4].min, cronFieldBounds[4].max, true)
	if err != nil {
		return parsedCron{}, err
	}
	if dows != nil && dows[7] {
		delete(dows, 7)
		dows[0] = true
	}
	andDays := strings.HasPrefix(parts[2], "*") || strings.HasPrefix(parts[4], "*")
	return parsedCron{
		minutes:  mins,
		hours:    hrs,
		days:     days,
		months:   months,
		weekdays: dows,
		andDays:  andDays,
	}, nil
}

func parseCronField(field string, lo, hi int, nilWhenWildcard bool) (map[int]bool, error) {
	if field == "*" && nilWhenWildcard {
		return nil, nil
	}
	out := make(map[int]bool)
	for item := range strings.SplitSeq(field, ",") {
		if item == "" {
			return nil, fmt.Errorf("%w: empty item in field %q", ErrInvalidCronSchedule, field)
		}
		span := item
		step := 1
		if slash := strings.IndexByte(item, '/'); slash >= 0 {
			span = item[:slash]
			stepVal, err := strconv.Atoi(item[slash+1:])
			if err != nil || stepVal < 1 {
				return nil, fmt.Errorf("%w: bad step in %q", ErrInvalidCronSchedule, field)
			}
			step = stepVal
		}
		from := lo
		to := hi
		if span != "*" {
			if dash := strings.IndexByte(span, '-'); dash >= 0 {
				x, err1 := strconv.Atoi(span[:dash])
				y, err2 := strconv.Atoi(span[dash+1:])
				if err1 != nil || err2 != nil {
					return nil, fmt.Errorf("%w: bad range in %q", ErrInvalidCronSchedule, field)
				}
				from, to = x, y
			} else {
				x, err := strconv.Atoi(span)
				if err != nil {
					return nil, fmt.Errorf("%w: bad value in %q", ErrInvalidCronSchedule, field)
				}
				from = x
				if strings.ContainsRune(item, '/') {
					to = hi
				} else {
					to = x
				}
			}
		}
		if from < lo || to > hi || from > to {
			return nil, fmt.Errorf("%w: out-of-range field %q", ErrInvalidCronSchedule, field)
		}
		for v := from; v <= to; v += step {
			out[v] = true
		}
	}
	return out, nil
}

func sortedMapKeys(m map[int]bool, lo, hi int) []int {
	if len(m) == 0 {
		out := make([]int, 0, hi-lo+1)
		for i := lo; i <= hi; i++ {
			out = append(out, i)
		}
		return out
	}
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func (c parsedCron) matchesDay(day time.Time) bool {
	if len(c.months) > 0 && !c.months[int(day.Month())] {
		return false
	}
	if len(c.days) == 0 && len(c.weekdays) == 0 {
		return true
	}
	domMatch := len(c.days) == 0 || c.days[day.Day()]
	dowMatch := len(c.weekdays) == 0 || c.weekdays[int(day.Weekday())]
	if c.andDays {
		return domMatch && dowMatch
	}
	if len(c.weekdays) == 0 {
		return domMatch
	}
	if len(c.days) == 0 {
		return dowMatch
	}
	return domMatch || dowMatch
}

func nextCronMatch(spec parsedCron, loc *time.Location, afterMs int64) (int64, bool) {
	start := time.UnixMilli(afterMs).In(loc)
	hours := sortedMapKeys(spec.hours, 0, 23)
	minutes := sortedMapKeys(spec.minutes, 0, 59)

	for i := -1; i < cronSearchDays; i++ {
		day := time.Date(start.Year(), start.Month(), start.Day()+i, 0, 0, 0, 0, loc)
		if !spec.matchesDay(day) {
			continue
		}
		for _, h := range hours {
			for _, mi := range minutes {
				cand := time.Date(day.Year(), day.Month(), day.Day(), h, mi, 0, 0, loc)
				ms := cand.UnixMilli()
				if ms > afterMs {
					return ms, true
				}
			}
		}
	}
	return 0, false
}
