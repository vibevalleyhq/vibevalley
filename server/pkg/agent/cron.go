package agent

// Cron expressions, as Effect's Cron reads them: five fields (minute hour day month weekday) or six (seconds
// first); each a `*`, numbers, ranges `a-b`, steps `*/n` or `a-b/n`, lists of those, month and weekday names; a
// weekday 7 is Sunday. When both day and weekday are restricted, either matching is enough (as cron does).

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Cron is a parsed expression in a time zone.
type Cron struct {
	seconds, minutes, hours, days, months, weekdays map[int]bool
	// Whether days / weekdays were restricted (not `*`).
	daysSet, weekdaysSet bool
	loc                  *time.Location
}

var monthNames = map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
var weekdayNames = map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}

func parseField(field string, low, high int, names map[string]int) (map[int]bool, bool, error) {
	set := map[int]bool{}
	value := func(s string) (int, error) {
		if n, ok := names[strings.ToLower(s)]; ok {
			return n, nil
		}
		n, err := strconv.Atoi(s)
		if err != nil {
			return 0, fmt.Errorf("Invalid value %q", s)
		}
		return n, nil
	}
	restricted := field != "*"
	for _, part := range strings.Split(field, ",") {
		if part == "" {
			return nil, false, fmt.Errorf("Invalid expression %q", field)
		}
		step := 1
		if base, s, ok := strings.Cut(part, "/"); ok {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 {
				return nil, false, fmt.Errorf("Invalid step %q", s)
			}
			step = n
			part = base
		}
		from, to := low, high
		switch {
		case part == "*":
		case strings.Contains(part, "-"):
			a, b, _ := strings.Cut(part, "-")
			var err error
			if from, err = value(a); err != nil {
				return nil, false, err
			}
			if to, err = value(b); err != nil {
				return nil, false, err
			}
		default:
			n, err := value(part)
			if err != nil {
				return nil, false, err
			}
			from, to = n, n
			if step > 1 {
				to = high
			}
		}
		if from < low || to > high || from > to {
			return nil, false, fmt.Errorf("Value out of range (%d-%d) in %q", low, high, field)
		}
		for n := from; n <= to; n += step {
			set[n] = true
		}
	}
	return set, restricted, nil
}

// ParseCronExpression reads expr in loc.
func ParseCronExpression(expr string, loc *time.Location) (*Cron, error) {
	fields := strings.Fields(expr)
	if len(fields) == 5 {
		fields = append([]string{"0"}, fields...)
	}
	if len(fields) != 6 {
		return nil, fmt.Errorf("Invalid number of segments in cron expression")
	}
	c := &Cron{loc: loc}
	var err error
	if c.seconds, _, err = parseField(fields[0], 0, 59, nil); err != nil {
		return nil, err
	}
	if c.minutes, _, err = parseField(fields[1], 0, 59, nil); err != nil {
		return nil, err
	}
	if c.hours, _, err = parseField(fields[2], 0, 23, nil); err != nil {
		return nil, err
	}
	if c.days, c.daysSet, err = parseField(fields[3], 1, 31, nil); err != nil {
		return nil, err
	}
	if c.months, _, err = parseField(fields[4], 1, 12, monthNames); err != nil {
		return nil, err
	}
	if c.weekdays, c.weekdaysSet, err = parseField(fields[5], 0, 7, weekdayNames); err != nil {
		return nil, err
	}
	if c.weekdays[7] {
		c.weekdays[0] = true
	}
	return c, nil
}

func (c *Cron) dayMatches(t time.Time) bool {
	day, weekday := c.days[t.Day()], c.weekdays[int(t.Weekday())]
	switch {
	case c.daysSet && c.weekdaysSet:
		return day || weekday
	case c.daysSet:
		return day
	case c.weekdaysSet:
		return weekday
	}
	return true
}

// Next is the first moment after from that matches; zero when none in the next five years.
func (c *Cron) Next(from time.Time) time.Time {
	t := from.In(c.loc).Truncate(time.Second).Add(time.Second)
	limit := t.AddDate(5, 0, 0)
	for t.Before(limit) {
		if !c.months[int(t.Month())] {
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, c.loc)
			continue
		}
		if !c.dayMatches(t) {
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, c.loc)
			continue
		}
		if !c.hours[t.Hour()] {
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, c.loc)
			continue
		}
		if !c.minutes[t.Minute()] {
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute()+1, 0, 0, c.loc)
			continue
		}
		if !c.seconds[t.Second()] {
			t = t.Add(time.Second)
			continue
		}
		return t
	}
	return time.Time{}
}
