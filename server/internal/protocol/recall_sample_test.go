package protocol

// recall.sample.json is the Flutter client's check on its port of Pick (app/lib/desk/shared/recall.dart, read by
// app/test/recall_parity_test.dart): cases made for each of Pick's branches, then the first recall cases of
// testdata/rules.jsonl.gz, each with what Pick makes of it. Compared on every run, written again with -update.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

type recallSampleCase struct {
	Name     string          `json:"name"`
	Cue      recallSampleCue `json:"cue"`
	Memories []Memory        `json:"memories"`
	Pick     []string        `json:"pick"`
}

type recallSampleCue struct {
	Helper  string   `json:"helper"`
	Project string   `json:"project"`
	Text    string   `json:"text"`
	Skip    []string `json:"skip"`
	Now     int64    `json:"now"`
}

const recallSampleGolden = 20

func TestRecallSample(t *testing.T) {
	cases := append(recallSampleBranches(), recallSampleGoldenCases(t)...)
	for i := range cases {
		c := &cases[i]
		ids := map[string]bool{}
		for _, m := range c.Memories {
			if ids[m.ID] {
				t.Fatalf("%s: two memories are %s, so the pick's ids would not say which", c.Name, m.ID)
			}
			ids[m.ID] = true
		}
		cue := Cue{Helper: c.Cue.Helper, Project: c.Cue.Project, Text: c.Cue.Text, Skip: map[string]bool{}, Now: c.Cue.Now}
		for _, id := range c.Cue.Skip {
			cue.Skip[id] = true
		}
		c.Pick = coreIDs(Pick(c.Memories, cue))
	}
	golden(t, "../../../app/schema/recall.sample.json", indented(t, cases))
}

func recallSampleGoldenCases(t *testing.T) []recallSampleCase {
	t.Helper()
	var out []recallSampleCase
	for i, body := range readCases(t, "testdata/rules.jsonl.gz").lines {
		var row struct {
			Fn string          `json:"fn"`
			In json.RawMessage `json:"in"`
		}
		coreDecode(t, i+1, body, &row)
		if row.Fn != "recall" {
			continue
		}
		c := recallSampleCase{Name: fmt.Sprintf("rules.jsonl.gz line %d", i+1)}
		coreDecode(t, i+1, row.In, &c)
		out = append(out, c)
		if len(out) == recallSampleGolden {
			return out
		}
	}
	t.Fatalf("rules.jsonl.gz has %d recall cases, not %d", len(out), recallSampleGolden)
	return nil
}

func recallSampleBranches() []recallSampleCase {
	const hour = coreDay / 24
	cue := func(text string, skip ...string) recallSampleCue {
		return recallSampleCue{Helper: "w9", Project: "clock", Text: text, Skip: append([]string{}, skip...), Now: coreNow}
	}
	noHelper := func(c recallSampleCue) recallSampleCue {
		c.Helper = ""
		return c
	}
	memory := func(kind MemoryKind, id, project string, ago int64, text string, change ...func(*Memory)) Memory {
		m := Memory{ID: id, Agent: "lab", Kind: kind, Text: text, At: coreNow - ago}
		if project != "" {
			m.Project = corePtr(project)
		}
		for _, c := range change {
			c(&m)
		}
		return m
	}
	note := func(id, project string, ago int64, text string, change ...func(*Memory)) Memory {
		return memory(MemoryKindNote, id, project, ago, text, change...)
	}
	job := func(id, project string, ago int64, text string, change ...func(*Memory)) Memory {
		return memory(MemoryKindJob, id, project, ago, text, change...)
	}
	by := func(helper string) func(*Memory) {
		return func(m *Memory) { m.Helper = corePtr(helper) }
	}
	recalled := func(ago int64) func(*Memory) {
		return func(m *Memory) { m.Recalled, m.RecalledAt = 1, corePtr(coreNow-ago) }
	}
	units := func(ms ...Memory) int {
		n := 0
		for _, m := range ms {
			n += coreUnits(LineOf(m, "clock")) + 1
		}
		return n
	}
	padded := func(m Memory, n int) Memory {
		m.Text += strings.Repeat("~", n-units(m))
		return m
	}

	var ten []Memory
	for i := 9; i >= 0; i-- {
		ten = append(ten, note(fmt.Sprintf("n%d", i), "clock", int64(i)*hour, fmt.Sprintf("第 %d 条约定", i)))
	}
	var jobs []Memory
	for i := range 5 {
		jobs = append(jobs, job(fmt.Sprintf("j%d", i), "clock", int64(i)*hour, fmt.Sprintf("打卡 接口 第 %d 件", i), by("w2")))
	}
	places := func(over int) []Memory {
		ms := []Memory{
			note("clock", "clock", hour, "迁移文件在 db/migrations"),
			note("blog", "blog", hour, "分页 limit offset 默认 20 条"),
			note("everywhere", "", hour, "提交信息写中文"),
		}
		return append(ms, padded(job("job", "clock", hour, "做好了打卡", by("w2")), RecallChars-units(ms...)+over))
	}
	short := note("short", "clock", hour, "短")

	return []recallSampleCase{
		{Name: "no memories", Cue: cue("给打卡记录加个分页"), Memories: []Memory{}},
		{Name: "none bears on the turn: another project's job, and its note with no words in common", Cue: cue("打卡 接口 分页"), Memories: []Memory{
			job("blog-job", "blog", hour, "打卡 接口 分页 做好了", by("w2")),
			note("blog-note", "blog", hour, "博客用 hugo 生成"),
		}},
		{Name: "the helper's own memories and the ones already in its session are left out", Cue: cue("加个分页", "seen"), Memories: []Memory{
			note("own", "clock", hour, "迁移文件在 db/migrations", by("w9")),
			note("seen", "clock", 2*hour, "改表先写迁移"),
			note("w2", "clock", 3*hour, "测试用 pnpm test", by("w2")),
			note("agent", "clock", 4*hour, "接口返回 JSON"),
		}},
		{Name: "with no helper, as the agent page asks, every helper's memories come", Cue: noHelper(cue("加个分页")), Memories: []Memory{
			note("w9", "clock", hour, "迁移文件在 db/migrations", by("w9")),
			job("w1", "clock", 2*hour, "做好了打卡", by("w1")),
		}},
		{Name: "jobs come from this project only, not another project or every project", Cue: cue("打卡 接口 分页"), Memories: []Memory{
			job("blog", "blog", hour, "打卡 接口 分页 做好了", by("w2")),
			job("everywhere", "", 2*hour, "打卡 接口 分页 做好了", by("w2")),
			job("clock", "clock", 3*hour, "打卡 接口 分页 做好了", by("w2")),
		}},
		{Name: "another project's note comes with three words in common, not two", Cue: cue("分页 接口 limit offset"), Memories: []Memory{
			note("two", "blog", hour, "分页 接口"),
			note("three", "blog", 2*hour, "分页 接口 limit"),
		}},
		{Name: "ranked by kind and place: this project's note, another project's with words in common, every project's, a job", Cue: cue("分页 limit offset"), Memories: []Memory{
			job("job", "clock", hour, "做好了打卡", by("w2")),
			note("everywhere", "", hour, "提交信息写中文"),
			note("blog", "blog", hour, "分页 limit offset 默认 20 条"),
			note("clock", "clock", hour, "迁移文件在 db/migrations"),
		}},
		{Name: "more words in common rank higher, counted up to eight", Cue: cue("alpha bravo charlie delta echo foxtrot golf hotel india juliet"), Memories: []Memory{
			note("seven", "clock", 0, "alpha bravo charlie delta echo foxtrot golf"),
			note("ten", "clock", 2*coreDay, "alpha bravo charlie delta echo foxtrot golf hotel india juliet"),
			note("eight", "clock", coreDay, "alpha bravo charlie delta echo foxtrot golf hotel"),
		}},
		{Name: "a word in common outweighs fifteen days, not sixteen", Cue: cue("加个分页"), Memories: []Memory{
			note("today", "clock", 0, "接口返回 JSON"),
			note("day16", "clock", 16*coreDay, "分页 默认 50 条"),
			note("day15", "clock", 15*coreDay, "分页 默认 20 条"),
		}},
		{Name: "the last time it was recalled counts as used", Cue: cue("加个分页"), Memories: []Memory{
			note("written", "clock", coreDay, "接口返回 JSON"),
			note("recalled", "clock", 30*coreDay, "迁移文件在 db/migrations", recalled(12*hour)),
		}},
		{Name: "a memory dated after now is as fresh as now, no fresher", Cue: cue("加个分页"), Memories: []Memory{
			note("later", "", -30*coreDay, "提交信息写中文"),
			note("clock", "clock", hour, "迁移文件在 db/migrations"),
		}},
		{Name: "equal relevance: the later written first", Cue: cue("加个分页"), Memories: []Memory{
			note("older", "clock", 10*coreDay, "迁移文件在 db/migrations", recalled(coreDay)),
			note("newer", "clock", 5*coreDay, "接口返回 JSON", recalled(coreDay)),
		}},
		{Name: "equal relevance, written at the same time: in the order given", Cue: cue("加个分页"), Memories: []Memory{
			note("c", "clock", coreDay, "迁移文件在 db/migrations"),
			note("a", "clock", coreDay, "接口返回 JSON"),
			note("b", "clock", coreDay, "测试用 pnpm test"),
		}},
		{Name: "equal relevance from different parts: another project's note with five words in common, this project's with none", Cue: cue("alpha bravo charlie delta echo"), Memories: []Memory{
			note("clock", "clock", 4*coreDay, "迁移文件在 db/migrations", recalled(coreDay)),
			note("blog", "blog", 3*coreDay, "alpha bravo charlie delta echo", recalled(coreDay)),
		}},
		{Name: "at most RecallCount memories, the most relevant", Cue: cue("加个分页"), Memories: ten},
		{Name: "at most RecallJobs jobs: the ones after are passed over, a note after them still comes", Cue: cue("打卡 接口"), Memories: append(jobs,
			note("everywhere", "", 0, "提交信息写中文"),
		)},
		{Name: "a line that would go past RecallChars is passed over, a shorter one after it still comes", Cue: cue("加个分页"), Memories: []Memory{
			padded(note("first", "clock", 0, "很长的一条"), 1000),
			padded(note("second", "clock", hour, "也很长的一条"), 700),
			note("third", "clock", 2*hour, "短的一条"),
		}},
		{Name: "lines of each place and kind that come to RecallChars exactly all fit", Cue: cue("分页 limit offset"), Memories: places(0)},
		{Name: "one unit past RecallChars, the last is passed over", Cue: cue("分页 limit offset"), Memories: places(1)},
		{Name: "an emoji takes two units of RecallChars", Cue: cue("加个分页"), Memories: []Memory{
			padded(note("emoji", "clock", 0, "😀"), RecallChars-units(short)+1),
			short,
		}},
		{Name: "Latin words count in lower case, one letter and the common words do not", Cue: cue("Run PNPM Test for the API x y"), Memories: []Memory{
			note("common", "blog", hour, "run pnpm the for x y"),
			note("upper", "blog", 2*hour, "RUN pnpm TEST"),
		}},
		{Name: "Latin words keep the dots, dashes and slashes inside them", Cue: cue("db/migrations v1.2.3 a-b -x"), Memories: []Memory{
			note("split", "blog", hour, "db migrations v1 2 3 a b x"),
			note("whole", "blog", 2*hour, "db/migrations v1.2.3 a-b"),
		}},
		{Name: "İ lowers to i and a combining dot, which ends the word", Cue: cue("aİd foo bar"), Memories: []Memory{
			note("aid", "blog", hour, "aid foo bar"),
			note("ai", "blog", 2*hour, "ai foo bar"),
		}},
		{Name: "the Kelvin sign lowers to k", Cue: cue("\u212aelvin foo bar"), Memories: []Memory{
			note("kelvin", "blog", hour, "kelvin foo bar"),
		}},
		{Name: "Chinese counts by pairs of characters in a row, not the common pairs", Cue: cue("我们给打卡记录加分页"), Memories: []Memory{
			note("pairs", "blog", hour, "打卡 记录 分页"),
			note("common", "blog", 2*hour, "我们 一个 打卡 记录"),
			note("singles", "blog", 3*hour, "打 卡 记 录 分 页"),
		}},
		{Name: "Chinese is U+3400 to U+9FFF", Cue: cue("\u3400\u3400 \u9fff\u9fff \u33ff\u33ff \ua000\ua000 打卡"), Memories: []Memory{
			note("outside", "blog", hour, "\u3400\u3400 \u9fff\u9fff \u33ff\u33ff \ua000\ua000"),
			note("inside", "blog", 2*hour, "\u3400\u3400 \u9fff\u9fff 打卡"),
		}},
	}
}
