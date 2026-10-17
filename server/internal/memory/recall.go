package memory

// Pure, no model: the server picks at the start of each turn, and the agent page shows the same pick ahead of time.

import (
	"cmp"
	"math"
	"regexp"
	"slices"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

const (
	// Characters are UTF-16 units.
	recallCount = 8
	recallJobs  = 3
	recallChars = 1600
)

var recallStop = map[string]bool{}

func init() {
	for _, w := range strings.Fields("一个 这个 那个 我们 你们 他们 可以 需要 什么 没有 就是 不是 然后 如果 因为 所以 已经 还是 这样 时候 一下 the and for with this that from are was you to of in is it on") {
		recallStop[w] = true
	}
}

var (
	recallWord = regexp.MustCompile(`[a-z0-9_][a-z0-9_.\-/]*`)
	recallHan  = regexp.MustCompile(`[\x{3400}-\x{9fff}]+`)
)

// Latin words and numbers in lower case, and each pair of Chinese characters in a row.
func termsOf(text string) map[string]bool {
	terms := map[string]bool{}
	for _, word := range recallWord.FindAllString(str.Lower(text), -1) {
		if len(word) >= 2 && !recallStop[word] {
			terms[word] = true
		}
	}
	for _, run := range recallHan.FindAllString(text, -1) {
		chars := []rune(run)
		for i := 0; i+1 < len(chars); i++ {
			if pair := string(chars[i : i+2]); !recallStop[pair] {
				terms[pair] = true
			}
		}
	}
	return terms
}

func termsInCommon(a, b map[string]bool) int {
	n := 0
	for t := range a {
		if b[t] {
			n++
		}
	}
	return n
}

type pickCue struct {
	// What it left itself is in its own session already.
	Worker  string          `json:"worker"`
	Project string          `json:"project"`
	Text    string          `json:"text"`
	Skip    map[string]bool `json:"-"`
	Now     int64           `json:"now"`
}

const recallElsewhere = 3

// Another project's note only when it plainly shares the turn's words; another project's job never.
func relevance(m protocol.Memory, cue pickCue, terms map[string]bool) (float64, bool) {
	if cue.Skip[m.ID] || (m.Worker != nil && *m.Worker == cue.Worker) {
		return 0, false
	}
	shared := termsInCommon(termsOf(m.Text), terms)
	here := m.Project != nil && *m.Project == cue.Project
	everywhere := m.Project == nil
	if m.Kind == protocol.MemoryKindIssue {
		if !here {
			return 0, false
		}
	} else if !here && !everywhere && shared < recallElsewhere {
		return 0, false
	}
	used := m.At
	if m.RecalledAt != nil {
		used = *m.RecalledAt
	}
	age := math.Max(0, float64(cue.Now-used)) / protocol.DayMs
	kind := 0.5
	if m.Kind == protocol.MemoryKindNote {
		kind = 2
	}
	place := 0.0
	if here {
		place = 2
	} else if everywhere {
		place = 1
	}
	// The conversion stops a fused multiply-add (arm64), so the order does not depend on the machine.
	return kind + place + float64(float64(min(shared, 8))*0.4) + math.Exp(-age/30), true
}

func lineOf(m protocol.Memory, project string) string {
	where := "所有项目"
	if m.Project != nil {
		if *m.Project == project {
			where = "这个项目"
		} else {
			where = "项目 " + *m.Project
		}
	}
	if m.Kind == protocol.MemoryKindIssue {
		return "- 做过（" + where + "）：" + m.Text
	}
	return "- （" + where + "）" + m.Text
}

func pick(memories []protocol.Memory, cue pickCue) []protocol.Memory {
	terms := termsOf(cue.Text)
	type scored struct {
		m     protocol.Memory
		score float64
	}
	var ranked []scored
	for _, m := range memories {
		if score, ok := relevance(m, cue, terms); ok {
			ranked = append(ranked, scored{m, score})
		}
	}
	slices.SortStableFunc(ranked, func(a, b scored) int {
		if c := cmp.Compare(b.score, a.score); c != 0 {
			return c
		}
		return cmp.Compare(b.m.At, a.m.At)
	})
	picked := []protocol.Memory{}
	chars, jobs := 0, 0
	for _, r := range ranked {
		if len(picked) == recallCount {
			break
		}
		length := str.Units(lineOf(r.m, cue.Project)) + 1
		if (r.m.Kind == protocol.MemoryKindIssue && jobs == recallJobs) || chars+length > recallChars {
			continue
		}
		picked = append(picked, r.m)
		chars += length
		if r.m.Kind == protocol.MemoryKindIssue {
			jobs++
		}
	}
	return picked
}

// The longest unused (last recalled, else written) go first.
func nextForgotten(memories []protocol.Memory, coming int) []string {
	over := len(memories) + coming - protocol.MemoryKeep
	if over <= 0 {
		return []string{}
	}
	used := func(m protocol.Memory) int64 {
		if m.RecalledAt != nil {
			return *m.RecalledAt
		}
		return m.At
	}
	sorted := slices.Clone(memories)
	slices.SortStableFunc(sorted, func(a, b protocol.Memory) int { return cmp.Compare(used(a), used(b)) })
	ids := make([]string, 0, min(over, len(sorted)))
	for _, m := range sorted[:min(over, len(sorted))] {
		ids = append(ids, m.ID)
	}
	return ids
}
