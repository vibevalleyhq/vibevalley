package projects

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

// A project seen as a code base (ported from the TypeScript server's codebase.ts, removed), for the page that shows it: the projects with their
// newest commit, what one is written in, and a year of its commits.
//
// What it is written in is counted by tokei (github.com/XAMPPRocky/tokei) when the page asks. tokei keeps to what git
// keeps (it reads .gitignore) and tells code, comments and blank lines apart. Lock files, minified files and
// dependency or build folders are left out. tokei has to be installed; without it the count is refused, saying how
// to get it. Where it is is VIBEVALLEY_TOKEI, or tokei on the PATH.
//
// The commits are git's, on every branch (helpers' unharvested work counts too), merges left out, by local day.

// crewLeftOut is not what a project is written in (gitignore patterns, as tokei's --exclude takes them).
var crewLeftOut = []string{
	"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock",
	"Pipfile.lock", "Gemfile.lock", "composer.lock", "*.min.js", "*.min.css", "*.map", "node_modules/", "vendor/", "dist/", "build/",
	"target/", ".venv/", "venv/", "__pycache__/", ".next/", "coverage/",
}

// crewTokeiArgs is tokei's arguments to count path, as JSON.
func crewTokeiArgs(path string) []string {
	args := []string{"--output", "json"}
	for _, p := range crewLeftOut {
		args = append(args, "--exclude", p)
	}
	return append(args, path)
}

// crewNoTokei is how to get tokei, for when it is not there.
const crewNoTokei = "统计代码要用 tokei，这台机器上没找到：装一个（brew install tokei，或 cargo install tokei）再点统计"

// crewYearDays is the commit calendar's reach: 53 weeks, so a whole year of weeks shows whatever day it is.
const crewYearDays = 53 * 7

const (
	crewTokeiTimeout = time.Minute
	crewTokeiOutput  = 256 * 1024 * 1024
)

// crewCountsOf is tokei's JSON output as a count per language, most lines (code and comments) first; its total, and
// languages with nothing but blank lines, left out. ok false when it is not tokei's output.
func crewCountsOf(output string) ([]protocol.LanguageCount, bool) {
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
		return crewLocaleCompare(a.Name, b.Name)
	})
	return out, true
}

// crewLocaleCompare is close to JavaScript's localeCompare for names: case ignored first.
func crewLocaleCompare(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

// crewLocalDay is a time's day on this machine's calendar, 'YYYY-MM-DD'.
func crewLocalDay(ms int64) string { return time.UnixMilli(ms).Local().Format("2006-01-02") }

// crewActivityOf is git log's `%at<tab>%aN` lines as commits per day (oldest first) and per author (most first).
func crewActivityOf(log string, dayOf func(int64) string) (days []protocol.DayCount, authors []protocol.Author) {
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
		return crewLocaleCompare(a.Name, b.Name)
	})
	return days, authors
}

// GitQuiet is git's trimmed output, or empty when it fails (no commits yet, not a repository).
func GitQuiet(cwd string, args ...string) string {
	out, err := crewGit(cwd, args...)
	if err != nil {
		return ""
	}
	return out
}

// crewSeconds is a time from git's `%at` (seconds) in milliseconds; 0 when there is none.
func crewSeconds(text string) int64 {
	n, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || n <= 0 || math.IsInf(n, 0) {
		return 0
	}
	return int64(n * 1000)
}

type Codebase struct {
	projects *Projects
	tokei    string
}

func newCodebase(projects *Projects) (*Codebase, error) {
	tokei := os.Getenv("VIBEVALLEY_TOKEI")
	if tokei == "" {
		tokei = "tokei"
	}
	return &Codebase{projects: projects, tokei: tokei}, nil
}

func (*Codebase) OnStart(context.Context) error { return nil }
func (*Codebase) OnStop()                       {}

// find is only a folder the work directory has: a name is never a path of its own.
func (c *Codebase) find(name string) *base.Project {
	for _, p := range c.projects.List() {
		if p.Name == name {
			return &p
		}
	}
	return nil
}

// List is the projects, each as Summary has it.
func (c *Codebase) List(ctx context.Context) []protocol.ProjectSummary {
	out := []protocol.ProjectSummary{}
	for _, p := range c.projects.List() {
		out = append(out, c.Summary(p))
	}
	return out
}

// Summary is a project with its newest commit's time and how many helpers may work in it at once.
func (c *Codebase) Summary(p base.Project) protocol.ProjectSummary {
	s := protocol.ProjectSummary{Name: p.Name, Path: p.Path, Git: p.Git, Slots: c.projects.Slots()}
	if p.Git {
		if last := crewSeconds(GitQuiet(p.Path, "log", "--all", "-1", "--format=%at")); last > 0 {
			s.Last = &last
		}
	}
	return s
}

// Languages is what project name is written in, counted now; nil, nil when there is no such project; an error saying
// why it could not count.
func (c *Codebase) Languages(ctx context.Context, name string) (*protocol.ProjectLanguages, error) {
	project := c.find(name)
	if project == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, crewTokeiTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, c.tokei, crewTokeiArgs(project.Path)...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			return nil, errors.New(crewNoTokei)
		}
		return nil, errors.New("tokei 没数完：" + err.Error())
	}
	if out.Len() > crewTokeiOutput {
		return nil, errors.New("tokei 没数完：输出太长")
	}
	languages, ok := crewCountsOf(out.String())
	if !ok {
		return nil, errors.New("tokei 的输出读不懂：换个新一点的 tokei 试试")
	}
	return &protocol.ProjectLanguages{Project: name, At: base.NowMs(), Languages: languages}, nil
}

// Activity is a year of project name's commits; nil when there is no such project.
func (c *Codebase) Activity(ctx context.Context, name string) *protocol.ProjectActivity {
	project := c.find(name)
	if project == nil {
		return nil
	}
	now := base.NowMs()
	out := &protocol.ProjectActivity{Project: name, At: now, Days: []protocol.DayCount{}, Authors: []protocol.Author{}}
	if !project.Git {
		return out
	}
	since := time.UnixMilli(now - crewYearDays*base.DayMs).UTC().Format("2006-01-02T15:04:05.000Z")
	log := GitQuiet(project.Path, "log", "--all", "--no-merges", "--since="+since, "--format=%at%x09%aN")
	total := GitQuiet(project.Path, "rev-list", "--all", "--no-merges", "--count")
	roots := GitQuiet(project.Path, "log", "--all", "--max-parents=0", "--format=%at")
	last := GitQuiet(project.Path, "log", "--all", "-1", "--format=%at")
	out.Days, out.Authors = crewActivityOf(log, crewLocalDay)
	out.Total, _ = strconv.ParseInt(total, 10, 64)
	first := int64(0)
	for _, line := range strings.Split(roots, "\n") {
		if at := crewSeconds(line); at > 0 && (first == 0 || at < first) {
			first = at
		}
	}
	if first > 0 {
		out.First = &first
	}
	if at := crewSeconds(last); at > 0 {
		out.Last = &at
	}
	return out
}
