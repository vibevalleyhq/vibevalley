package project

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

// tokei keeps to what git keeps (it reads .gitignore). Commits are counted on every branch (sessions' unharvested work counts too), merges left out,
// by local day.

// Not what a project is written in: gitignore patterns, as tokei's --exclude takes them.
var leftOut = []string{
	"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock",
	"Pipfile.lock", "Gemfile.lock", "composer.lock", "*.min.js", "*.min.css", "*.map", "node_modules/", "vendor/", "dist/", "build/",
	"target/", ".venv/", "venv/", "__pycache__/", ".next/", "coverage/",
}

func tokeiArgs(path string) []string {
	args := []string{"--output", "json"}
	for _, p := range leftOut {
		args = append(args, "--exclude", p)
	}
	return append(args, path)
}

const noTokei = "统计代码要用 tokei，这台机器上没找到：装一个（brew install tokei，或 cargo install tokei）再点统计"

// 53 weeks, so a whole year of weeks shows whatever day it is.
const yearDays = 53 * 7

const (
	tokeiTimeout = time.Minute
	tokeiOutput  = 256 * 1024 * 1024
)

// Its total, and languages with nothing but blank lines, left out. ok false when it is not tokei's output.
func countsOf(output string) ([]protocol.LanguageCount, bool) {
	var raw map[string]json.RawMessage
	if json.Unmarshal([]byte(output), &raw) != nil || raw == nil {
		return nil, false
	}
	out := []protocol.LanguageCount{}
	for name, body := range raw {
		var l struct {
			Code     *float64          `json:"code"`
			Comments *float64          `json:"comments"`
			Blanks   *float64          `json:"blanks"`
			Reports  []json.RawMessage `json:"reports"`
		}
		if json.Unmarshal(body, &l) != nil || l.Code == nil || l.Comments == nil || l.Blanks == nil || l.Reports == nil {
			return nil, false
		}
		if name == "Total" || *l.Code+*l.Comments <= 0 {
			continue
		}
		out = append(out, protocol.LanguageCount{Name: name, Files: int64(len(l.Reports)), Code: int64(*l.Code), Comments: int64(*l.Comments), Blanks: int64(*l.Blanks)})
	}
	slices.SortFunc(out, func(a, b protocol.LanguageCount) int {
		if d := (b.Code + b.Comments) - (a.Code + a.Comments); d != 0 {
			return int(d)
		}
		return localeCompare(a.Name, b.Name)
	})
	return out, true
}

// localeCompare is close to JavaScript's localeCompare for names: case ignored first.
func localeCompare(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

func localDay(ms int64) string { return time.UnixMilli(ms).Local().Format("2006-01-02") }

func activityOf(log string, dayOf func(int64) string) (days []protocol.DayCount, authors []protocol.Author) {
	byDay, byAuthor := map[string]int64{}, map[string]int64{}
	for _, line := range strings.Split(log, "\n") {
		tab := strings.Index(line, "\t")
		if tab < 0 {
			continue
		}
		seconds, err := strconv.ParseFloat(strings.TrimSpace(line[:tab]), 64)
		if err != nil || math.IsInf(seconds, 0) || seconds <= 0 {
			continue
		}
		byDay[dayOf(int64(seconds*1000))]++
		name := strings.TrimSpace(line[tab+1:])
		if name == "" {
			name = "无名"
		}
		byAuthor[name]++
	}
	days, authors = []protocol.DayCount{}, []protocol.Author{}
	for day, n := range byDay {
		days = append(days, protocol.DayCount{Day: day, Commits: n})
	}
	slices.SortFunc(days, func(a, b protocol.DayCount) int { return strings.Compare(a.Day, b.Day) })
	for name, n := range byAuthor {
		authors = append(authors, protocol.Author{Name: name, Commits: n})
	}
	slices.SortFunc(authors, func(a, b protocol.Author) int {
		if a.Commits != b.Commits {
			return int(b.Commits - a.Commits)
		}
		return localeCompare(a.Name, b.Name)
	})
	return days, authors
}

func GitQuiet(cwd string, args ...string) string {
	out, err := git(cwd, args...)
	if err != nil {
		return ""
	}
	return out
}

func seconds(text string) int64 {
	n, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || n <= 0 || math.IsInf(n, 0) {
		return 0
	}
	return int64(n * 1000)
}

// A name is never a path of its own.
func (p *Service) find(name string) *Project {
	for _, x := range p.List() {
		if x.Name == name {
			return &x
		}
	}
	return nil
}

func (p *Service) Summaries(ctx context.Context) []protocol.ProjectSummary {
	out := []protocol.ProjectSummary{}
	for _, x := range p.List() {
		out = append(out, p.Summary(x))
	}
	return out
}

func (p *Service) Summary(project Project) protocol.ProjectSummary {
	s := protocol.ProjectSummary{Name: project.Name, Path: project.Path, Git: project.Git, Slots: p.Slots()}
	if project.Git {
		if last := seconds(GitQuiet(project.Path, "log", "--all", "-1", "--format=%at")); last > 0 {
			s.Last = &last
		}
	}
	return s
}

func (p *Service) Languages(ctx context.Context, name string) (*protocol.ProjectLanguages, error) {
	project := p.find(name)
	if project == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, tokeiTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, p.tokei, tokeiArgs(project.Path)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			return nil, errors.New(noTokei)
		}
		return nil, errors.New("tokei 没数完：" + err.Error())
	}
	if out.Len() > tokeiOutput {
		return nil, errors.New("tokei 没数完：输出太长")
	}
	languages, ok := countsOf(out.String())
	if !ok {
		return nil, errors.New("tokei 的输出读不懂：换个新一点的 tokei 试试")
	}
	return &protocol.ProjectLanguages{Project: name, At: clock.NowMs(), Languages: languages}, nil
}

func (p *Service) Activity(ctx context.Context, name string) *protocol.ProjectActivity {
	project := p.find(name)
	if project == nil {
		return nil
	}
	now := clock.NowMs()
	out := &protocol.ProjectActivity{Project: name, At: now, Days: []protocol.DayCount{}, Authors: []protocol.Author{}}
	if !project.Git {
		return out
	}
	since := time.UnixMilli(now - yearDays*protocol.DayMs).UTC().Format("2006-01-02T15:04:05.000Z")
	log := GitQuiet(project.Path, "log", "--all", "--no-merges", "--since="+since, "--format=%at%x09%aN")
	total := GitQuiet(project.Path, "rev-list", "--all", "--no-merges", "--count")
	roots := GitQuiet(project.Path, "log", "--all", "--max-parents=0", "--format=%at")
	last := GitQuiet(project.Path, "log", "--all", "-1", "--format=%at")
	out.Days, out.Authors = activityOf(log, localDay)
	out.Total, _ = strconv.ParseInt(total, 10, 64)
	first := int64(0)
	for _, line := range strings.Split(roots, "\n") {
		if at := seconds(line); at > 0 && (first == 0 || at < first) {
			first = at
		}
	}
	if first > 0 {
		out.First = &first
	}
	if at := seconds(last); at > 0 {
		out.Last = &at
	}
	return out
}
