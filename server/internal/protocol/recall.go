package protocol

// What a helper's turn is reminded of from its agent's memory (packages/protocol/src/recall.ts): the server picks it
// at the start of each turn, and the agent page shows the same pick ahead of time. Pure functions, no model: words
// in common, the same project, how recent.

import (
	"cmp"
	"math"
	"regexp"
	"slices"
	"strings"
)

const (
	// RecallCount, RecallJobs, RecallChars: a turn is reminded of this many memories (this many of them jobs) in this
	// many characters (UTF-16 units), at most.
	RecallCount = 8
	RecallJobs  = 3
	RecallChars = 1600
	// MemoryKeep is how many memories an agent keeps; past this, the ones longest unused go.
	MemoryKeep = 300
)

// ── Words in common ──────────────────────────────────────────────────────────

// recallStop are pairs and words too common to say what a text is about.
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

// TermsOf is what a text is about, as terms: Latin words and numbers in lower case, and each pair of Chinese
// characters in a row.
func TermsOf(text string) map[string]bool {
	terms := map[string]bool{}
	for _, word := range recallWord.FindAllString(coreLower(text), -1) {
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

func TermsInCommon(a, b map[string]bool) int {
	n := 0
	for t := range a {
		if b[t] {
			n++
		}
	}
	return n
}

// ── What a turn is reminded of ───────────────────────────────────────────────

// Cue is a turn about to start, as recall sees it.
type Cue struct {
	// Helper is the helper about to work: what it left itself is in its own session already.
	Helper  string `json:"helper"`
	Project string `json:"project"`
	// Text is what the turn is asked.
	Text string `json:"text"`
	// Skip are memories already brought into its session.
	Skip map[string]bool `json:"-"`
	Now  int64           `json:"now"`
}

const (
	recallDay = 86_400_000
	// recallElsewhere is the words in common that make another project's note worth bringing.
	recallElsewhere = 3
)

// Relevance is how much a memory bears on a turn; false when it does not. Notes before jobs; this project's, then
// every project's; then words in common and how recently it was written or used. Another project's note only when
// it plainly shares the turn's words; another project's job never.
func Relevance(m Memory, cue Cue, terms map[string]bool) (float64, bool) {
	if cue.Skip[m.ID] || (m.Helper != nil && *m.Helper == cue.Helper) {
		return 0, false
	}
	shared := TermsInCommon(TermsOf(m.Text), terms)
	here := m.Project != nil && *m.Project == cue.Project
	everywhere := m.Project == nil
	if m.Kind == MemoryKindJob {
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
	age := math.Max(0, float64(cue.Now-used)) / recallDay
	kind := 0.5
	if m.Kind == MemoryKindNote {
		kind = 2
	}
	place := 0.0
	if here {
		place = 2
	} else if everywhere {
		place = 1
	}
	return kind + place + float64(min(shared, 8))*0.4 + math.Exp(-age/30), true
}

// LineOf is a memory as a line of the reminder.
func LineOf(m Memory, project string) string {
	where := "所有项目"
	if m.Project != nil {
		if *m.Project == project {
			where = "这个项目"
		} else {
			where = "项目 " + *m.Project
		}
	}
	if m.Kind == MemoryKindJob {
		return "- 做过（" + where + "）：" + m.Text
	}
	return "- （" + where + "）" + m.Text
}

// Pick is the memories a turn is reminded of: the most relevant first, within RecallCount, RecallJobs and
// RecallChars.
func Pick(memories []Memory, cue Cue) []Memory {
	terms := TermsOf(cue.Text)
	type scored struct {
		m     Memory
		score float64
	}
	var ranked []scored
	for _, m := range memories {
		if score, ok := Relevance(m, cue, terms); ok {
			ranked = append(ranked, scored{m, score})
		}
	}
	slices.SortStableFunc(ranked, func(a, b scored) int {
		if c := cmp.Compare(b.score, a.score); c != 0 {
			return c
		}
		return cmp.Compare(b.m.At, a.m.At)
	})
	picked := []Memory{}
	chars, jobs := 0, 0
	for _, r := range ranked {
		if len(picked) == RecallCount {
			break
		}
		length := coreUnits(LineOf(r.m, cue.Project)) + 1
		if (r.m.Kind == MemoryKindJob && jobs == RecallJobs) || chars+length > RecallChars {
			continue
		}
		picked = append(picked, r.m)
		chars += length
		if r.m.Kind == MemoryKindJob {
			jobs++
		}
	}
	return picked
}

// NextForgotten is the memories (their ids, the first to go first) that go when the agent keeps more than
// MemoryKeep and its helpers add coming more: the longest unused (last recalled, else written). Mirrors
// trimMemories in the TypeScript server's db/queries/memories.sql (removed).
func NextForgotten(memories []Memory, coming int) []string {
	over := len(memories) + coming - MemoryKeep
	if over <= 0 {
		return []string{}
	}
	used := func(m Memory) int64 {
		if m.RecalledAt != nil {
			return *m.RecalledAt
		}
		return m.At
	}
	sorted := slices.Clone(memories)
	slices.SortStableFunc(sorted, func(a, b Memory) int { return cmp.Compare(used(a), used(b)) })
	ids := make([]string, 0, min(over, len(sorted)))
	for _, m := range sorted[:min(over, len(sorted))] {
		ids = append(ids, m.ID)
	}
	return ids
}
