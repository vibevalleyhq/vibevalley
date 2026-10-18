package memory

import (
	"context"
	"slices"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/ptr"
)

func TestTermsAreWordsAndWholeCode(t *testing.T) {
	for text, want := range map[string][]string{
		"这个项目测试用 pnpm test":       {"项目", "测试", "pnpm", "test"},
		"迁移文件在 db/migrations":     {"迁移", "文件", "db/migrations"},
		"登录态统一走 refreshSession()": {"登录", "统一", "refreshsession"},
		"表名单数":                    {"名单", "单数"},
		"v1.2.3 发布":               {"发布", "v1.2.3"},
	} {
		got := termsList(text)
		for _, w := range want {
			if !slices.Contains(got, w) {
				t.Errorf("%q: %v has no %q", text, got, w)
			}
		}
	}
	if q := matchQuery(`说 "引号"`); q != `"引号"` {
		t.Fatalf("query %s", q)
	}
	if matchQuery("的 了 a") != "" {
		t.Fatal("a query from no words")
	}
}

func TestTheSearchIndexFollowsTheTable(t *testing.T) {
	f := memoryWorld(t)
	note, err := f.Memory.Write(Note{Agent: "lab", Text: "这个项目测试用 pnpm test", Project: "demo", By: protocol.MemoryAuthorOwner})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Memory.Write(Note{Agent: "other", Text: "测试前先装依赖", Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	if got := f.Memory.matches("lab", "跑一遍测试"); len(got) != 1 || got[note.ID] <= 0 {
		t.Fatalf("matched %v", got)
	}
	if err := f.Memory.Forget("lab", note.ID); err != nil {
		t.Fatal(err)
	}
	if got := f.Memory.matches("lab", "跑一遍测试"); len(got) != 0 {
		t.Fatalf("a forgotten memory still matches: %v", got)
	}
}

func TestMovedMemoriesAreCutAgain(t *testing.T) {
	f := memoryWorld(t)
	if _, err := f.DB.Exec(`insert into memory (id, scope, agent, kind, body, author, created_at, updated_at) values ('moved', 'agent', 'lab', 'note', '迁移文件放 db/migrations', 'agent', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if got := f.Memory.matches("lab", "迁移"); len(got) != 0 {
		t.Fatalf("uncut yet matched %v", got)
	}
	recutTerms(context.Background(), generated.New(f.DB))
	if got := f.Memory.matches("lab", "迁移放哪"); len(got) != 1 {
		t.Fatalf("cut again, matched %v", got)
	}
	var version int64
	if err := f.DB.QueryRow(`select terms_of from memory where id = 'moved'`).Scan(&version); err != nil || version != TermsVersion {
		t.Fatalf("terms_of %d %v", version, err)
	}
}

func TestAFullTextMatchRanksAMemoryHigher(t *testing.T) {
	memories := []protocol.Memory{
		recallMemory("plain", "这个项目的约定一", func(m *protocol.Memory) { m.Project = ptr.To("clock") }),
		recallMemory("matched", "这个项目的约定二", func(m *protocol.Memory) { m.Project = ptr.To("clock") }),
	}
	testkit.Eq(t, recallIDs(pick(memories, recallCue("做点什么", func(c *pickCue) { c.Matches = map[string]float64{"matched": 2} }))), []string{"matched", "plain"})
	testkit.Eq(t, recallIDs(pick(memories, recallCue("做点什么", func(c *pickCue) { c.Matches = map[string]float64{"plain": 99} }))), []string{"plain", "matched"})
}
