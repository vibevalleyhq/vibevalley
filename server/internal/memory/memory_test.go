package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/agent"
)

func TestMemoryNotesOfARun(t *testing.T) {
	said := strings.Join([]string{
		"改好了，测试也过了。",
		"",
		"记住：这个项目用 pnpm test 跑测试，不要用 npm",
		"- 记住：迁移文件在 db/migrations",
		"**记住（所有项目）：** 主人要提交信息写中文",
		"记住：这个项目用 pnpm test 跑测试，不要用 npm",
		"要记住的是别的事",
		"记住：",
		"",
		"结论：加好了分页（3f2a1bc）。",
	}, "\n")
	want := []memoryNote{
		{Text: "这个项目用 pnpm test 跑测试，不要用 npm"},
		{Text: "迁移文件在 db/migrations"},
		{Text: "主人要提交信息写中文", Everywhere: true},
	}
	if got := memoryNotesOf(said); !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
	var many []string
	for i := range 9 {
		many = append(many, "记住：第 "+string(rune('0'+i))+" 条")
	}
	if n := len(memoryNotesOf(strings.Join(many, "\n"))); n != memoryNotesPerRun {
		t.Fatalf("%d notes", n)
	}
	if len(memoryNotesOf("结论：做完了。")) != 0 {
		t.Fatal("no notes in a conclusion")
	}
}

func TestMemoryJobText(t *testing.T) {
	if got := memoryJobText("给打卡接口加分页", "加好了（3f2a1bc）", protocol.OutcomeCompleted); got != "给打卡接口加分页 → 加好了（3f2a1bc）" {
		t.Fatal(got)
	}
	if got := memoryJobText("给打卡接口加分页", "pnpm test 没过", protocol.OutcomeFailed); got != "给打卡接口加分页 → 没做成：pnpm test 没过" {
		t.Fatal(got)
	}
}

func TestMemoryNearlyTheSameNoteIsNoNews(t *testing.T) {
	clock, blog := "clock", "blog"
	known := []protocol.Memory{{ID: "1", Agent: "lab", Kind: protocol.MemoryKindNote, Text: "这个项目用 pnpm test 跑测试", Project: &clock}}
	if memoryIsNewNote(known, "这个项目用 pnpm test 跑测试", &clock) {
		t.Fatal("the same note is news")
	}
	if !memoryIsNewNote(known, "这个项目用 pnpm test 跑测试", &blog) {
		t.Fatal("another project's is news")
	}
	if !memoryIsNewNote(known, "数据库迁移放在 db/migrations", &clock) {
		t.Fatal("another note is news")
	}
}

func TestMemoriesKeepRecallWriteForget(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.DB.Close() })
	m := f.Memory
	m.Keep(FinishedRun{Agent: "lab", Session: "w1", Project: "clock", Job: "加分页", Outcome: protocol.OutcomeCompleted,
		Said: "记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文\n结论：加好了", Summary: "加好了"})
	m.Keep(FinishedRun{Agent: "lab", Session: "w1", Project: "clock", Job: "加分页", Outcome: protocol.OutcomeFailed,
		Said: "记住：这个项目用 pnpm test 跑测试", Summary: "测试没过"})
	m.Keep(FinishedRun{Agent: "lab", Session: "w2", Project: "clock", Job: "不算", Outcome: protocol.OutcomeInterrupted, Said: "记住：停下的不算"})
	all := m.List("lab")
	var texts []string
	for _, x := range all {
		texts = append(texts, string(x.Kind)+":"+x.Text)
	}
	want := map[string]bool{"note:这个项目用 pnpm test 跑测试": true, "note:提交信息写中文": true, "issue:加分页 → 没做成：测试没过": true}
	if len(texts) != 3 {
		t.Fatalf("%q", texts)
	}
	for _, text := range texts {
		if !want[text] {
			t.Fatalf("%q", texts)
		}
	}
	for _, x := range all {
		if x.Text == "提交信息写中文" && x.Project != nil {
			t.Fatal("a note for every project has none")
		}
	}

	picked := m.Recall(RecallCue{Agent: "lab", Session: "w9", Project: "clock", Text: "跑测试"})
	if len(picked.IDs) != 3 || len(picked.Lines) != 3 || picked.Lines[0] != "- （这个项目）这个项目用 pnpm test 跑测试" {
		t.Fatalf("recalled %+v", picked)
	}
	for _, x := range m.List("lab") {
		if x.Recalled != 1 || x.RecalledAt == nil {
			t.Fatalf("not counted: %+v", x)
		}
	}

	note, err := m.Write("lab", "  周末别派夜班  ", " clock ")
	if err != nil || note.Text != "周末别派夜班" || note.Project == nil || *note.Project != "clock" || note.Kind != protocol.MemoryKindNote {
		t.Fatalf("%+v %v", note, err)
	}
	if _, err := m.Write("lab", "  ", ""); err == nil || err.Error() != "要记的话是空的" {
		t.Fatalf("%v", err)
	}
	if err := m.Forget("lab", note.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Forget("lab", "not-a-number"); err != nil {
		t.Fatal(err)
	}
	if len(m.List("lab")) != 3 || len(m.List("other")) != 0 {
		t.Fatal("forgot the wrong one")
	}
}

func openManagerMemory(t *testing.T) (*managerMemory, string) {
	t.Helper()
	home := t.TempDir()
	cfg := fixture.Config(home, "", "")
	mm, err := newManagerMemory(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return mm, filepath.Join(home, protocol.ManagerAgent)
}

func TestManagerMemoryLines(t *testing.T) {
	memory, folder := openManagerMemory(t)
	if len(memory.Manager().Memories) != 0 {
		t.Fatal("remembers something already")
	}
	if err := agent.Remember(folder, "主人喜欢早上收到汇报", time.Date(2026, 10, 12, 9, 0, 0, 0, time.Local)); err != nil {
		t.Fatal(err)
	}
	written, err := memory.WriteManager("  周末别派夜班\n真的  ")
	if err != nil || written.Text != "周末别派夜班 真的" || written.Session != nil {
		t.Fatalf("%+v %v", written, err)
	}
	file, _ := os.ReadFile(filepath.Join(folder, "MEMORY.md"))
	if !strings.Contains(string(file), memoryFromPerson+"周末别派夜班 真的") {
		t.Fatalf("the manager does not read whose it is:\n%s", file)
	}

	view := memory.Manager()
	if len(view.Memories) != 2 {
		t.Fatalf("%+v", view)
	}
	if view.Memories[0].Text != "周末别派夜班 真的" || view.Memories[0].Session != nil ||
		view.Memories[1].Text != "主人喜欢早上收到汇报" || view.Memories[1].Session == nil || *view.Memories[1].Session != protocol.ManagerAgent {
		t.Fatalf("%+v", view.Memories)
	}
	if view.Memories[1].At != time.Date(2026, 10, 12, 0, 0, 0, 0, time.Local).UnixMilli() {
		t.Fatalf("dated %d", view.Memories[1].At)
	}
	if view.Carried != 2 {
		t.Fatalf("carried %d", view.Carried)
	}
	if err := memory.ForgetManager(view.Memories[1].ID); err != nil {
		t.Fatal(err)
	}
	if left := memory.Manager().Memories; len(left) != 1 || left[0].Text != "周末别派夜班 真的" {
		t.Fatalf("%+v", left)
	}
	if _, err := memory.WriteManager("  "); err == nil || err.Error() != "要记的话是空的" {
		t.Fatalf("%v", err)
	}
}

func TestManagerMemoryCarriedLines(t *testing.T) {
	lines := make([]agent.MemoryLine, 100)
	for i := range lines {
		lines[i] = agent.MemoryLine{ID: string(rune('a' + i%26)), Date: "2026-10-13", Text: strings.Repeat("字", 100)}
	}
	if n := memoryCarriedLines(lines); n <= 0 || n >= 100 {
		t.Fatalf("carried %d", n)
	}
	if n := memoryCarriedLines(lines[:3]); n != 3 {
		t.Fatalf("carried %d", n)
	}
}

func TestManagerMemoryArchive(t *testing.T) {
	memory, folder := openManagerMemory(t)
	if err := os.MkdirAll(filepath.Join(folder, "archive"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(folder, "archive", "manager-2026-10-12.md"), []byte("主人：给 clock-in 加分页\n管家：派给老周了\n"), 0o644)
	os.WriteFile(filepath.Join(folder, "MEMORY.md"), nil, 0o644)
	listing := memory.Archive("CLOCK-IN")
	if len(listing.Files) != 1 || listing.Files[0].Name != "manager-2026-10-12.md" {
		t.Fatalf("%+v", listing.Files)
	}
	if len(listing.Hits) != 1 || listing.Hits[0].File != "manager-2026-10-12.md" || listing.Hits[0].Line != 1 {
		t.Fatalf("%+v", listing.Hits)
	}
	if hits := memory.Archive("").Hits; hits == nil || len(hits) != 0 {
		t.Fatalf("%+v", hits)
	}
	if text, ok := memory.ArchiveFile("manager-2026-10-12.md"); !ok || !strings.Contains(text, "派给老周") {
		t.Fatalf("%q", text)
	}
	if _, ok := memory.ArchiveFile("../MEMORY.md"); ok {
		t.Fatal("read outside the archive")
	}
}

func TestPreviewPicksWithoutCountingAndTheLongestUnusedFade(t *testing.T) {
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.DB.Close() })
	m := f.Memory
	if _, err := m.Write("lab", "clock 的测试用 pnpm test", "clock"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Write("lab", "提交前跑 lint", ""); err != nil {
		t.Fatal(err)
	}
	preview := m.Preview("lab", "clock", "")
	testkit.Eq(t, preview.Lines, []string{"- （这个项目）clock 的测试用 pnpm test", "- （所有项目）提交前跑 lint"}, "picked")
	testkit.Eq(t, preview.Limit, int64(recallChars), "limit")
	for _, x := range m.List("lab") {
		testkit.Eq(t, x.Recalled, int64(0), "a preview is no recall")
		testkit.Eq(t, x.Fading, false, "far from full")
	}
	testkit.Eq(t, len(m.Preview("lab", "", "").Lines), 0, "no project, nothing")

	for i := range protocol.MemoryKeep - memoryFadingSoon {
		if _, err := m.Write("lab", fmt.Sprintf("第 %d 条，各不相同 %d", i, i*7919), ""); err != nil {
			t.Fatal(err)
		}
	}
	var fading []string
	for _, x := range m.List("lab") {
		if x.Fading {
			fading = append(fading, x.Text)
		}
	}
	// Written in the same millisecond, any two of them are the longest unused.
	testkit.Eq(t, len(fading), 2, "ten more would push out two")
}
