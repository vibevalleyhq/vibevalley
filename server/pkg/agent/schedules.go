package agent

// One missed while the agent was away runs once when it is back, not once per miss. Cron is in the machine's time zone.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/agentcore"
)

type Job struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Message string `json:"message"`
	// One of: a cron expression, a moment (ISO), every so many minutes.
	Cron         string   `json:"cron,omitempty"`
	At           string   `json:"at,omitempty"`
	EveryMinutes *float64 `json:"everyMinutes,omitempty"`
	Created      string   `json:"created"`
	LastRun      string   `json:"lastRun,omitempty"`
}

// Date.toISOString.
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// As `new Date(text)` reads the forms people (and models) write: ISO with a zone (`+08:00`, `+0800` or `Z`; a space for the T; seconds optional) or
// without one (local time), a day with dashes (UTC midnight, as JS reads it), or a day with slashes and an optional time (local).
func parseDate(text string) (time.Time, bool) {
	s := strings.TrimSpace(text)
	for _, layout := range []string{
		time.RFC3339Nano, "2006-01-02T15:04Z07:00", "2006-01-02T15:04:05.999999999Z0700", "2006-01-02T15:04Z0700",
		"2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04Z07:00", "2006-01-02 15:04:05.999999999Z0700", "2006-01-02 15:04Z0700",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	for _, layout := range []string{
		"2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02 15:04:05.999999999", "2006-01-02 15:04",
		"2006/1/2 15:04:05", "2006/1/2 15:04", "2006/1/2",
	} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, true
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func ParseCron(expr string) (*Cron, error) {
	c, err := ParseCronExpression(expr, time.Local)
	if err != nil {
		return nil, fmt.Errorf("cron 写得不对（%s）：五段，分 时 日 月 周，比如 0 9 * * 1-5 是工作日早上九点。", err.Error())
	}
	return c, nil
}

func NextRun(job Job) (time.Time, bool) {
	fromText := job.LastRun
	if fromText == "" {
		fromText = job.Created
	}
	from, _ := parseDate(fromText)
	if job.At != "" {
		if job.LastRun != "" {
			return time.Time{}, false
		}
		at, ok := parseDate(job.At)
		return at, ok
	}
	if job.EveryMinutes != nil && *job.EveryMinutes != 0 {
		return from.Add(time.Duration(*job.EveryMinutes * float64(time.Minute))), true
	}
	if job.Cron != "" {
		c, err := ParseCron(job.Cron)
		if err != nil {
			return time.Time{}, false
		}
		next := c.Next(from)
		return next, !next.IsZero()
	}
	return time.Time{}, false
}

func DueJobs(jobs []Job, now time.Time) []Job {
	var out []Job
	for _, j := range jobs {
		if next, ok := NextRun(j); ok && !next.After(now) {
			out = append(out, j)
		}
	}
	return out
}

// toLocaleString('zh-CN', { hour12: false }).
func localeTime(t time.Time) string { return t.Local().Format("2006/1/2 15:04:05") }

func formatMinutes(n float64) string { return strconv.FormatFloat(n, 'f', -1, 64) }

func DescribeJob(j Job) string {
	var when string
	switch {
	case j.At != "":
		at, _ := parseDate(j.At)
		when = localeTime(at) + " 一次"
	case j.EveryMinutes != nil && *j.EveryMinutes != 0:
		when = "每 " + formatMinutes(*j.EveryMinutes) + " 分钟"
	default:
		when = "cron " + j.Cron
	}
	next := "（不会再跑）"
	if t, ok := NextRun(j); ok {
		next = localeTime(t)
	}
	return "- " + j.ID + "「" + j.Name + "」" + when + "；下次 " + next + "\n  " + j.Message
}

func DueMessage(j Job) string {
	return "【定时任务「" + j.Name + "」到点了（" + j.ID + "）】\n" + j.Message
}

type Schedules struct {
	Tools []agentcore.AgentTool
	file  string
	home  string
	wake  func(text string)
	// The ticker and the tools both write the file.
	lock sync.Mutex
}

func (s *Schedules) load() ([]Job, error) {
	data, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return []Job{}, nil
	}
	if err != nil {
		return nil, err
	}
	var jobs []Job
	if err := json.Unmarshal(data, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

func (s *Schedules) store(jobs []Job) error {
	if jobs == nil {
		jobs = []Job{}
	}
	if err := os.MkdirAll(s.home, 0o755); err != nil {
		return err
	}
	data, _ := json.Marshal(jobs)
	if err := os.WriteFile(s.file+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(s.file+".tmp", s.file)
}

func (s *Schedules) change(f func(jobs []Job) ([]Job, error)) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	before, err := s.load()
	if err != nil {
		return err
	}
	jobs, err := f(before)
	if err != nil {
		return err
	}
	return s.store(jobs)
}

func (s *Schedules) List() []Job {
	jobs, err := s.load()
	if err != nil {
		log.Printf("agent: cannot read schedules: %v", err)
	}
	return jobs
}

// At most once each.
func (s *Schedules) Tick(now time.Time) {
	var due []Job
	err := s.change(func(jobs []Job) ([]Job, error) {
		due = DueJobs(jobs, now)
		isDue := map[string]bool{}
		for _, j := range due {
			isDue[j.ID] = true
		}
		after := []Job{}
		for _, j := range jobs {
			switch {
			case !isDue[j.ID]:
				after = append(after, j)
			case j.At != "":
			default:
				j.LastRun = isoTime(now)
				after = append(after, j)
			}
		}
		return after, nil
	})
	if err != nil {
		log.Printf("agent: cannot claim due schedules: %v", err)
		return
	}
	for _, j := range due {
		s.wake(DueMessage(j))
	}
}

func MakeSchedules(home string, wake func(text string)) *Schedules {
	s := &Schedules{file: filepath.Join(home, "schedules.json"), home: home, wake: wake}

	type addParams struct {
		Name         string   `json:"name"`
		Message      string   `json:"message"`
		At           *string  `json:"at"`
		EveryMinutes *float64 `json:"every_minutes"`
		Cron         *string  `json:"cron"`
	}
	add := TextTool(TextToolSpec[addParams]{
		Name:        "schedule",
		Description: "定一个以后要做的事：到点时你会收到 message，像有人对你说的一样，然后去做。三选一：at（某个时刻，ISO 时间，比如 2026-10-13T09:00:00+08:00）、every_minutes（每隔几分钟）、cron（五段：分 时 日 月 周，本机时区）。message 写清楚到时候要做什么、做完告诉谁。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"name": agentcore.StringSchema(), "message": agentcore.StringSchema(), "at": agentcore.StringSchema(),
			"every_minutes": agentcore.NumberSchema(), "cron": agentcore.StringSchema(),
		}, "name", "message"),
		Run: func(_ context.Context, p addParams, _ ToolContext) (string, error) {
			ways := 0
			for _, given := range []bool{p.At != nil, p.EveryMinutes != nil, p.Cron != nil} {
				if given {
					ways++
				}
			}
			if ways != 1 {
				return "", errors.New("at、every_minutes、cron 要正好给一个。")
			}
			var at time.Time
			if p.At != nil {
				t, ok := parseDate(*p.At)
				if !ok {
					return "", fmt.Errorf("at 不是一个时间：%s。用 ISO 格式，带时区。", *p.At)
				}
				at = t
			}
			if p.EveryMinutes != nil && !(*p.EveryMinutes >= 1) {
				return "", errors.New("every_minutes 至少是 1。")
			}
			if p.Cron != nil {
				if _, err := ParseCron(*p.Cron); err != nil {
					return "", err
				}
			}
			now := time.Now()
			job := Job{ID: "job-" + strconv.FormatInt(now.UnixMilli(), 36), Name: p.Name, Message: p.Message, Created: isoTime(now), EveryMinutes: p.EveryMinutes}
			if p.At != nil {
				job.At = isoTime(at)
			}
			if p.Cron != nil {
				job.Cron = *p.Cron
			}
			if err := s.change(func(jobs []Job) ([]Job, error) { return append(jobs, job), nil }); err != nil {
				return "", err
			}
			return "定好了：\n" + DescribeJob(job), nil
		},
	})

	list := TextTool(TextToolSpec[struct{}]{
		Name:        "list_schedules",
		Description: "列出定好的事。",
		Parameters:  agentcore.ObjectSchema(nil),
		Run: func(context.Context, struct{}, ToolContext) (string, error) {
			jobs, err := s.load()
			if err != nil {
				return "", err
			}
			if len(jobs) == 0 {
				return "没有定好的事。", nil
			}
			lines := make([]string, 0, len(jobs))
			for _, j := range jobs {
				lines = append(lines, DescribeJob(j))
			}
			return strings.Join(lines, "\n"), nil
		},
	})

	type cancelParams struct {
		ID string `json:"id"`
	}
	cancel := TextTool(TextToolSpec[cancelParams]{
		Name:        "cancel_schedule",
		Description: "取消一件定好的事（id 从 list_schedules 看）。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"id": agentcore.StringSchema()}, "id"),
		Run: func(_ context.Context, p cancelParams, _ ToolContext) (string, error) {
			said := ""
			err := s.change(func(jobs []Job) ([]Job, error) {
				for i, j := range jobs {
					if j.ID == p.ID {
						said = "取消了「" + j.Name + "」。"
						return append(append([]Job{}, jobs[:i]...), jobs[i+1:]...), nil
					}
				}
				return nil, fmt.Errorf("没有 %s：先 list_schedules 看看。", p.ID)
			})
			return said, err
		},
	})

	s.Tools = []agentcore.AgentTool{add, list, cancel}
	return s
}
