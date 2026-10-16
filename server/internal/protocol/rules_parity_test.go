package protocol

import (
	"encoding/json"
	"maps"
	"math"
	"reflect"
	"slices"
	"testing"
	"time"
)

// coreNull is a Go result as the cases write it: null for an empty string.
func coreNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// coreSame compares got, as JSON, with the case's output (or records it there, with -update).
func coreSame(t *testing.T, line int, fn string, input json.RawMessage, got any, want json.RawMessage) bool {
	t.Helper()
	if recorded(got, "out") {
		return true
	}
	body, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("line %d %s: %v", line, fn, err)
	}
	var a, b any
	_ = json.Unmarshal(body, &a)
	_ = json.Unmarshal(want, &b)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("line %d %s(%s):\n got %s\nwant %s", line, fn, input, body, want)
		return false
	}
	return true
}

func coreDecode(t *testing.T, line int, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("line %d: %v: %s", line, err, raw)
	}
}

// The chat, recall, phase, quota, connector and settings rules against testdata/rules.jsonl.gz: seeded random calls
// (times of day read in Asia/Shanghai).
func TestRulesGolden(t *testing.T) {
	zone, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	was := time.Local
	time.Local = zone
	defer func() { time.Local = was }()

	cases := readCases(t, "testdata/rules.jsonl.gz")
	line, failed := 0, 0
	seen := map[string]int{}
	for _, body := range cases.lines {
		if failed >= 20 {
			break
		}
		line++
		cases.begin(line)
		var row struct {
			Fn  string          `json:"fn"`
			In  json.RawMessage `json:"in"`
			Out json.RawMessage `json:"out"`
		}
		coreDecode(t, line, body, &row)
		seen[row.Fn]++
		same := func(got any) {
			t.Helper()
			if !coreSame(t, line, row.Fn, row.In, got, row.Out) {
				failed++
			}
		}
		switch row.Fn {
		case "mentionsIn":
			var s string
			coreDecode(t, line, row.In, &s)
			same(MentionsIn(s))
		case "parseTarget":
			var s string
			coreDecode(t, line, row.In, &s)
			var want *ChatTarget
			coreDecode(t, line, row.Out, &want)
			if got := ParseTarget(s); !recorded(got, "out") && !reflect.DeepEqual(got, want) {
				t.Errorf("line %d parseTarget(%q): got %+v, want %s", line, s, got, row.Out)
				failed++
			}
		case "channelNameProblem":
			var in struct {
				Name  string   `json:"name"`
				Taken []string `json:"taken"`
			}
			coreDecode(t, line, row.In, &in)
			same(coreNull(ChannelNameProblem(in.Name, in.Taken)))
		case "targetOf":
			var in struct {
				C           Conversation `json:"c"`
				ChannelName *string      `json:"channelName"`
			}
			coreDecode(t, line, row.In, &in)
			same(TargetOf(in.C, in.ChannelName))
		case "audienceOf":
			var in AudienceInput
			coreDecode(t, line, row.In, &in)
			same(AudienceOf(in))
		case "wakeInput":
			var in struct {
				Messages []InboxMessage `json:"messages"`
				Others   []UnreadRow    `json:"others"`
			}
			coreDecode(t, line, row.In, &in)
			same(WakeInput(in.Messages, in.Others))
		case "busyNotice":
			var rows []UnreadRow
			coreDecode(t, line, row.In, &rows)
			same(BusyNotice(rows))
		case "recall":
			var in struct {
				Memories []Memory `json:"memories"`
				Cue      struct {
					Cue
					Skip []string `json:"skip"`
				} `json:"cue"`
			}
			coreDecode(t, line, row.In, &in)
			c := in.Cue.Cue
			c.Skip = map[string]bool{}
			for _, id := range in.Cue.Skip {
				c.Skip[id] = true
			}
			var want struct {
				Pick      []string   `json:"pick"`
				Relevance []*float64 `json:"relevance"`
				Terms     []string   `json:"terms"`
			}
			coreDecode(t, line, row.Out, &want)
			terms := TermsOf(c.Text)
			if *update {
				out := map[string]any{"terms": append([]string{}, slices.Sorted(maps.Keys(terms))...), "relevance": []any{}, "pick": []string{}}
				for _, m := range in.Memories {
					if score, ok := Relevance(m, c, terms); ok {
						out["relevance"] = append(out["relevance"].([]any), score)
					} else {
						out["relevance"] = append(out["relevance"].([]any), nil)
					}
				}
				for _, m := range Pick(in.Memories, c) {
					out["pick"] = append(out["pick"].([]string), m.ID)
				}
				recorded(out, "out")
				cases.end()
				continue
			}
			var gotTerms []string
			for term := range terms {
				gotTerms = append(gotTerms, term)
			}
			if len(gotTerms) != len(want.Terms) || !reflect.DeepEqual(terms, func() map[string]bool {
				m := map[string]bool{}
				for _, x := range want.Terms {
					m[x] = true
				}
				return m
			}()) {
				t.Errorf("line %d termsOf(%q): got %v, want %v", line, c.Text, gotTerms, want.Terms)
				failed++
			}
			for i, m := range in.Memories {
				score, ok := Relevance(m, c, terms)
				w := want.Relevance[i]
				if ok != (w != nil) || ok && math.Abs(score-*w) > 1e-12 {
					t.Errorf("line %d relevance of %s: got %v %v, want %v", line, m.ID, score, ok, w)
					failed++
				}
			}
			var picked []string
			for _, m := range Pick(in.Memories, c) {
				picked = append(picked, m.ID)
			}
			if !reflect.DeepEqual(append([]string{}, picked...), append([]string{}, want.Pick...)) {
				t.Errorf("line %d pick: got %v, want %v", line, picked, want.Pick)
				failed++
			}
		case "phaseText":
			var in struct {
				Helper Helper `json:"helper"`
				Now    int64  `json:"now"`
			}
			coreDecode(t, line, row.In, &in)
			same(PhaseText(in.Helper, in.Now))
		case "yuan":
			var cny float64
			coreDecode(t, line, row.In, &cny)
			same(Yuan(cny))
		case "spentText":
			var spent Spent
			coreDecode(t, line, row.In, &spent)
			same(SpentText(spent))
		case "quota":
			var usage AccountUsage
			coreDecode(t, line, row.In, &usage)
			var left any
			if l, ok := QuotaLeft(usage); ok {
				left = l
			}
			same(map[string]any{"left": left, "text": QuotaText(usage)})
		case "moneyStop":
			var info *RuntimeInfo
			coreDecode(t, line, row.In, &info)
			same(coreNull(MoneyStop(info)))
		case "agentIssues":
			var in struct {
				Agent   AgentProfile `json:"agent"`
				Runtime *RuntimeInfo `json:"runtime"`
			}
			coreDecode(t, line, row.In, &in)
			same(AgentIssues(in.Agent, in.Runtime))
		case "plainText":
			var s string
			coreDecode(t, line, row.In, &s)
			same(PlainText(s))
		case "splitText":
			var in struct {
				Text string `json:"text"`
				Max  int    `json:"max"`
			}
			coreDecode(t, line, row.In, &in)
			same(SplitText(in.Text, in.Max))
		case "flushText":
			var lines []string
			coreDecode(t, line, row.In, &lines)
			got := FlushText(lines)
			if got == nil {
				got = []string{}
			}
			same(got)
		case "isPairing":
			var in struct{ Text, Code string }
			coreDecode(t, line, row.In, &in)
			same(IsPairing(in.Text, in.Code))
		case "shortId":
			var s string
			coreDecode(t, line, row.In, &s)
			same(ShortID(s))
		case "ownerLine":
			var in struct {
				M     ChatMessage   `json:"m"`
				Where *Conversation `json:"where"`
			}
			coreDecode(t, line, row.In, &in)
			same(map[string]any{"line": OwnerLine(in.M, in.Where), "forOwner": ForOwner(in.M)})
		case "settingsProblem":
			var u SettingsUpdate
			coreDecode(t, line, row.In, &u)
			same(coreNull(SettingsProblem(u)))
		case "voiceProblem":
			var v SettingsUpdateVoice
			coreDecode(t, line, row.In, &v)
			same(coreNull(VoiceProblem(v)))
		case "voiceOverrides":
			var settings VoiceSettings
			coreDecode(t, line, row.In, &settings)
			var want struct {
				Overrides SettingsUpdateVoice `json:"overrides"`
			}
			coreDecode(t, line, row.Out, &want)
			same(map[string]any{"overrides": VoiceOverrides(DefaultVoice(), settings), "settings": VoiceSettingsOver(DefaultVoice(), want.Overrides)})
		case "keyHint":
			var s string
			coreDecode(t, line, row.In, &s)
			same(KeyHint(s))
		default:
			t.Fatalf("line %d: unknown fn %q", line, row.Fn)
		}
		cases.end()
	}
	cases.close()
	if line < 10_000 {
		t.Fatalf("only %d calls", line)
	}
	t.Logf("%d calls: %v", line, seen)
}
