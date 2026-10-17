package memory

import (
	"fmt"
	"slices"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestTermsOf(t *testing.T) {
	var terms []string
	for term := range termsOf("用 pnpm test 跑测试") {
		terms = append(terms, term)
	}
	slices.Sort(terms)
	want := []string{"pnpm", "test", "测试", "跑测"}
	slices.Sort(want)
	testkit.Eq(t, terms, want)
	if termsOf("我们需要一个接口")["一个"] {
		t.Error("一个 is too common")
	}
}

func TestPickNotes(t *testing.T) {
	memories := []protocol.Memory{
		recallMemory("here", "迁移文件在 db/migrations，改表先写迁移", func(m *protocol.Memory) { m.Project = ptr.To("clock") }),
		recallMemory("everywhere", "主人要提交信息写中文", nil),
		recallMemory("other", "博客用 hugo 生成", func(m *protocol.Memory) { m.Project = ptr.To("blog") }),
		recallMemory("other-related", "分页接口用 limit 和 offset 参数，默认 20 条", func(m *protocol.Memory) { m.Project = ptr.To("blog") }),
	}
	testkit.Eq(t, recallIDs(pick(memories, recallCue("打卡记录的接口加个分页", nil))), []string{"here", "everywhere"})
	testkit.Eq(t, recallIDs(pick(memories, recallCue("分页接口加上 limit 和 offset 参数", nil))), []string{"other-related", "here", "everywhere"})
}

func TestPickJobs(t *testing.T) {
	var memories []protocol.Memory
	for i := range 5 {
		memories = append(memories, recallMemory(fmt.Sprintf("job%d", i), fmt.Sprintf("第 %d 件活 → 做好了", i), func(m *protocol.Memory) {
			m.Kind, m.Project, m.Session, m.At = protocol.MemoryKindIssue, ptr.To("clock"), ptr.To(fmt.Sprintf("w%d", i)), recallNow-int64(i)*protocol.DayMs
		}))
	}
	memories = append(memories,
		recallMemory("note", "迁移文件在 db/migrations", func(m *protocol.Memory) { m.Project = ptr.To("clock") }),
		recallMemory("job-blog", "博客的活 → 做好了", func(m *protocol.Memory) {
			m.Kind, m.Project, m.Session = protocol.MemoryKindIssue, ptr.To("blog"), ptr.To("w8")
		}),
	)
	testkit.Eq(t, recallIDs(pick(memories, recallCue("随便做点什么", nil))), []string{"note", "job0", "job1", "job2"})
	testkit.Eq(t, recallIDs(pick(memories, recallCue("随便做点什么", func(c *pickCue) { c.Session, c.Skip = "w0", map[string]bool{"note": true} }))), []string{"job1", "job2", "job3"})
	var many []protocol.Memory
	for i := range 20 {
		many = append(many, recallMemory(fmt.Sprintf("n%d", i), fmt.Sprintf("这个项目的第 %d 条约定", i), func(m *protocol.Memory) { m.Project = ptr.To("clock") }))
	}
	testkit.Eq(t, len(pick(many, recallCue("做点什么", nil))), recallCount)
}

func TestLineOf(t *testing.T) {
	testkit.Eq(t, lineOf(recallMemory("1", "迁移文件在 db/migrations", func(m *protocol.Memory) { m.Project = ptr.To("clock") }), "clock"), "- （这个项目）迁移文件在 db/migrations")
	testkit.Eq(t, lineOf(recallMemory("2", "主人要提交信息写中文", nil), "clock"), "- （所有项目）主人要提交信息写中文")
}

func TestNextForgotten(t *testing.T) {
	var many []protocol.Memory
	for i := range protocol.MemoryKeep - 1 {
		many = append(many, recallMemory(fmt.Sprintf("n%d", i), fmt.Sprintf("第 %d 条", i), func(m *protocol.Memory) { m.At = recallNow - int64(i)*protocol.DayMs }))
	}
	testkit.Eq(t, len(nextForgotten(many, 1)), 0)
	recalled := slices.Clone(many)
	for i := range recalled {
		if recalled[i].ID == fmt.Sprintf("n%d", protocol.MemoryKeep-2) {
			recalled[i].RecalledAt = ptr.To[int64](recallNow)
		}
	}
	testkit.Eq(t, nextForgotten(recalled, 3), []string{fmt.Sprintf("n%d", protocol.MemoryKeep-3), fmt.Sprintf("n%d", protocol.MemoryKeep-4)})
}

const recallNow = 1_800_000_000_000

func recallMemory(id, text string, change func(*protocol.Memory)) protocol.Memory {
	m := protocol.Memory{ID: id, Agent: "lab", Kind: protocol.MemoryKindNote, Text: text, At: recallNow - protocol.DayMs}
	if change != nil {
		change(&m)
	}
	return m
}

func recallCue(text string, change func(*pickCue)) pickCue {
	c := pickCue{Session: "w9", Project: "clock", Text: text, Skip: map[string]bool{}, Now: recallNow}
	if change != nil {
		change(&c)
	}
	return c
}

func recallIDs(memories []protocol.Memory) []string {
	out := []string{}
	for _, m := range memories {
		out = append(out, m.ID)
	}
	return out
}
