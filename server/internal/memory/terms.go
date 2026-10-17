package memory

import (
	"bytes"
	"compress/gzip"
	"context"
	_ "embed"
	"io"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-ego/gse"

	"vibevalley/pkg/db/generated"
)

// Raised when the cut or the dictionary changes: every memory's terms are then cut again in the background (recutTerms).
const TermsVersion = 1

// gse's simplified Chinese dictionary only (dict/README.md): LoadDictEmbed would link its Japanese, traditional and idf ones
// too, some 30 MB.
//
//go:embed dict/zh_s.txt.gz
var dictGz []byte

var segmenter = sync.OnceValue(func() *gse.Segmenter {
	var seg gse.Segmenter
	r, err := gzip.NewReader(bytes.NewReader(dictGz))
	if err == nil {
		var text []byte
		if text, err = io.ReadAll(r); err == nil {
			err = seg.LoadDictStr(string(text))
		}
	}
	if err != nil {
		// The dictionary is in the binary: failing to read it is a broken build, not a state to run in.
		panic("memory: gse dictionary: " + err.Error())
	}
	return &seg
})

// Latin words, numbers and code as whole words, a path or a version one word (db/migrations, v1.2.3): gse would cut them into
// pieces, and one shared version would count as three shared words.
var codeWord = regexp.MustCompile(`[a-z0-9_][a-z0-9_.\-/]*[a-z0-9_]`)

func hasHan(w string) bool {
	return strings.IndexFunc(w, func(r rune) bool { return unicode.Is(unicode.Han, r) }) >= 0
}

// Words in lower case, in the order they come, each once. Chinese is gse's: its search cut and its every-word cut together, so
// a phrase cut two ways (表名单数: 表/名单/数, 单数) is found either way; single characters are left out. Everything else is
// codeWord's. Stop words are left out: they match everything.
func termsList(text string) []string {
	seg := segmenter()
	seen := map[string]bool{}
	var out []string
	add := func(w string) {
		if !seen[w] && !recallStop[w] {
			seen[w] = true
			out = append(out, w)
		}
	}
	for _, cut := range [][]string{seg.CutSearch(text, true), seg.CutAll(text)} {
		for _, w := range cut {
			if w = strings.TrimSpace(w); hasHan(w) && utf8.RuneCountInString(w) > 1 {
				add(w)
			}
		}
	}
	for _, w := range codeWord.FindAllString(strings.ToLower(text), -1) {
		add(w)
	}
	return out
}

func termsOf(text string) map[string]bool {
	terms := map[string]bool{}
	for _, w := range termsList(text) {
		terms[w] = true
	}
	return terms
}

// What the terms column holds: what FTS5's unicode61 splits back into these words.
func termsText(text string) string { return strings.Join(termsList(text), " ") }

// An FTS5 query for any of text's words, each quoted so no word reads as an operator; "" when it has none.
func matchQuery(text string) string {
	terms := termsList(text)
	for i, t := range terms {
		terms[i] = `"` + strings.ReplaceAll(t, `"`, `""`) + `"`
	}
	return strings.Join(terms, " OR ")
}

const recutBatch = 100

// Cuts again what an older TermsVersion cut, or what a migration moved uncut, a batch at a time until none is left or ctx ends.
// The terms are an index derived from the body, so this is rebuilding it, not reading old data.
func recutTerms(ctx context.Context, q *generated.Queries) {
	start := time.Now()
	done := 0
	for ctx.Err() == nil {
		rows, err := q.StaleTerms(ctx, generated.StaleTermsParams{Version: TermsVersion, N: recutBatch})
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("vibevalley: memories were not cut again: %v", err)
			}
			return
		}
		for _, row := range rows {
			if err := q.SetTerms(ctx, generated.SetTermsParams{Terms: termsText(row.Body), Version: TermsVersion, ID: row.ID}); err != nil {
				if ctx.Err() == nil {
					log.Printf("vibevalley: memory %s was not cut again: %v", row.ID, err)
				}
				return
			}
		}
		done += len(rows)
		if len(rows) < recutBatch {
			break
		}
	}
	if done > 0 {
		log.Printf("vibevalley: cut %d memories again for search in %s", done, time.Since(start).Round(time.Millisecond))
	}
}

// BM25 of the agent's memories that share any of text's words, as a strength (higher is better); none when the index cannot
// say. Recall goes on without it: the shared words still count.
func (m *memories) matches(agentID, text string) map[string]float64 {
	query := matchQuery(text)
	if query == "" {
		return nil
	}
	rows, err := m.q.MatchMemories(context.Background(), generated.MatchMemoriesParams{Query: query, Agent: agentID})
	if err != nil {
		log.Printf("vibevalley: searching %s's memories: %v", agentID, err)
		return nil
	}
	out := make(map[string]float64, len(rows))
	for _, r := range rows {
		out[r.ID] = -r.Score
	}
	return out
}
