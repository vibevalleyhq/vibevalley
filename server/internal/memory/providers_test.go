package memory

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/ptr"
)

// A provider outside the farm, played: what it gives and what it was given.
type fakeProvider struct {
	name      string
	available bool
	lines     []recalledLine
	listed    []protocol.Memory
	found     []Found
	slow      bool
	failSync  bool
	noForget  bool

	mu       sync.Mutex
	cues     []RecallCue
	searched []SearchQuery
	synced   []FinishedRun
	added    []Note
	forgot   []string
	started  bool
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) Available() (bool, string) {
	if !f.available {
		return false, "no address"
	}
	return true, ""
}
func (f *fakeProvider) OnStart(context.Context) error { f.started = true; return nil }
func (f *fakeProvider) OnStop()                       {}
func (f *fakeProvider) Prefetch(ctx context.Context, cue RecallCue) ([]recalledLine, error) {
	f.mu.Lock()
	f.cues = append(f.cues, cue)
	f.mu.Unlock()
	if f.slow {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return append([]recalledLine(nil), f.lines...), nil
}
func (f *fakeProvider) SyncTurn(_ context.Context, run FinishedRun) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.synced = append(f.synced, run)
	if f.failSync {
		return errors.New("down")
	}
	return nil
}
func (f *fakeProvider) Search(ctx context.Context, q SearchQuery) ([]Found, error) {
	f.mu.Lock()
	f.searched = append(f.searched, q)
	f.mu.Unlock()
	if f.slow {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return append([]Found(nil), f.found...), nil
}
func (f *fakeProvider) List(context.Context, string) ([]protocol.Memory, error) { return f.listed, nil }
func (f *fakeProvider) Add(_ context.Context, n Note) (protocol.Memory, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.added = append(f.added, n)
	return protocol.Memory{ID: "n1"}, nil
}
func (f *fakeProvider) OnSessionEnd(context.Context, EndedSession) error { return nil }
func (f *fakeProvider) Can() abilities                                   { return abilities{List: true, Forget: !f.noForget} }
func (f *fakeProvider) Forget(_ context.Context, _, id string) error {
	f.forgot = append(f.forgot, id)
	return nil
}

func memoryWorld(t *testing.T) *world {
	t.Helper()
	f, err := newWorld(fixture.Config(t.TempDir(), t.TempDir(), ":memory:"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.DB.Close() })
	return f
}

func withFake(t *testing.T, fake *fakeProvider) *world {
	t.Helper()
	f := memoryWorld(t)
	f.Memory.all = append(f.Memory.all, fake)
	f.Memory.timeout = 50 * time.Millisecond
	return f
}

func TestOneProviderRecallsAsBefore(t *testing.T) {
	f := memoryWorld(t)
	if _, err := f.Memory.Write(Note{Agent: "lab", Text: "这个项目测试用 pnpm test", Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	preview := f.Memory.Preview("lab", "demo", "跑测试")
	got := f.Memory.Recall(RecallCue{Agent: "lab", Project: "demo", Text: "跑测试"})
	if len(got.Lines) != 1 || !reflect.DeepEqual(got.Lines, preview.Lines) || len(got.IDs) != 1 || strings.Contains(got.IDs[0], ":") {
		t.Fatalf("recalled %+v, previewed %+v", got, preview.Lines)
	}
}

func TestASlowProviderDoesNotHoldARunUp(t *testing.T) {
	f := withFake(t, &fakeProvider{name: "slow", available: true, slow: true})
	if _, err := f.Memory.Write(Note{Agent: "lab", Text: "迁移文件放 db/migrations", Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	got := f.Memory.Recall(RecallCue{Agent: "lab", Project: "demo", Text: "迁移"})
	if took := time.Since(start); took > time.Second {
		t.Fatalf("waited %s on a slow provider", took)
	}
	if len(got.Lines) != 1 {
		t.Fatalf("the local memory went missing: %+v", got)
	}
}

func TestAnotherProvidersIDsCarryItsName(t *testing.T) {
	fake := &fakeProvider{name: "nowledge", available: true,
		lines:  []recalledLine{{ID: "m9", Line: "主人要中文的提交信息", Score: 100}},
		listed: []protocol.Memory{{ID: "m9", Agent: "lab", Kind: protocol.MemoryKindNote, Text: "主人要中文的提交信息"}}}
	f := withFake(t, fake)
	local, err := f.Memory.Write(Note{Agent: "lab", Text: "这个项目测试用 pnpm test", Project: "demo", By: protocol.MemoryAuthorOwner})
	if err != nil {
		t.Fatal(err)
	}
	got := f.Memory.Recall(RecallCue{Agent: "lab", Project: "demo", Text: "测试 提交", Skip: map[string]bool{"nowledge:m1": true, "other:m2": true, local.ID + "x": true}})
	if len(got.IDs) != 2 || got.IDs[0] != local.ID || got.IDs[1] != "nowledge:m9" || got.Lines[1] != "主人要中文的提交信息" {
		t.Fatalf("merged %+v", got)
	}
	if skip := fake.cues[0].Skip; !reflect.DeepEqual(skip, map[string]bool{"m1": true}) {
		t.Fatalf("the provider was told to skip %v", skip)
	}
	ids := []string{}
	for _, m := range f.Memory.List("lab") {
		ids = append(ids, m.ID)
	}
	if !reflect.DeepEqual(ids, []string{local.ID, "nowledge:m9"}) {
		t.Fatalf("listed %v", ids)
	}
	if err := f.Memory.Forget("lab", "nowledge:m9"); err != nil || !reflect.DeepEqual(fake.forgot, []string{"m9"}) {
		t.Fatalf("forgot %v %v", fake.forgot, err)
	}
	if err := f.Memory.Forget("lab", local.ID); err != nil || len(fake.forgot) != 1 || len(f.Memory.List("lab")) != 1 {
		t.Fatal("a local id reached the other provider, or stayed")
	}
}

func (f *fakeProvider) got() ([]FinishedRun, []Note) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.synced), slices.Clone(f.added)
}

func TestAProviderFailingToKeepLeavesTheOthersTheirs(t *testing.T) {
	fake := &fakeProvider{name: "everos", available: true, failSync: true}
	f := withFake(t, fake)
	run := FinishedRun{Agent: "lab", Session: "w1", Project: "demo", Job: "修登录页", Said: "改好了。\n记住：登录态统一走 refreshSession()", Summary: "改好了", Outcome: protocol.OutcomeCompleted}
	f.Memory.Keep(run)
	if got := f.Memory.List("lab"); len(got) != 2 {
		t.Fatalf("kept locally before Keep returned: %+v", got)
	}
	synced := testkit.Await(t, "the run at the other provider", func() ([]FinishedRun, bool) {
		synced, _ := fake.got()
		return synced, len(synced) == 1
	})
	if synced[0].Said != run.Said {
		t.Fatalf("the provider got %+v", synced)
	}
	if _, err := f.Memory.Write(Note{Agent: "lab", Text: "替它记一条", Project: "", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	added := testkit.Await(t, "the note at the other provider", func() ([]Note, bool) {
		_, added := fake.got()
		return added, len(added) == 1
	})
	if added[0].Text != "替它记一条" {
		t.Fatalf("a note: %+v", added)
	}
}

func TestSourcesFollowTheSettings(t *testing.T) {
	f := memoryWorld(t)
	fake := &fakeProvider{name: "nowledge"}
	built := 0
	f.Memory.build = func(c setting.MemorySourceConfig) provider {
		built++
		fake.available = c.URL != "http://down/"
		return fake
	}
	save := func(s protocol.MemorySourceUpdate) {
		t.Helper()
		if _, err := f.Setting.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{s}}); err != nil {
			t.Fatal(err)
		}
	}
	save(protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: "http://down/", Enabled: true, Read: true})
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	sources := f.Memory.Sources()
	if len(sources) != 2 || sources[0].Name != localName || !sources[0].On || sources[1].On || ptr.Value(sources[1].Off) != "no address" {
		t.Fatalf("sources %+v", sources)
	}
	save(protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: "http://up/", Enabled: true, Read: true})
	if sources := f.Memory.Sources(); !sources[1].On || !fake.started || sources[1].Label != "Nowledge Mem" {
		t.Fatalf("saved without a restart: %+v", sources)
	}
	f.Memory.Sources()
	if built != 2 {
		t.Fatalf("built %d times: only a change builds again", built)
	}
	save(protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: "http://up/"})
	if sources := f.Memory.Sources(); sources[1].On || ptr.Value(sources[1].Off) != "没打开" {
		t.Fatalf("switched off: %+v", sources)
	}
}

func TestOnlyWhatIsToldIsCountedAsRecalled(t *testing.T) {
	words := strings.Fields("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa")
	var lines []recalledLine
	for i := range recallCount {
		lines = append(lines, recalledLine{ID: fmt.Sprintf("m%d", i), Line: "- （Nowledge）外面的 " + words[i], Score: 1})
	}
	f := withFake(t, &fakeProvider{name: "nowledge", available: true, lines: lines})
	for i := range recallCount {
		if _, err := f.Memory.Write(Note{Agent: "lab", Text: "测试用 "+words[recallCount+i], Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
			t.Fatal(err)
		}
	}
	got := f.Memory.Recall(RecallCue{Agent: "lab", Project: "demo", Text: "测试"})
	local := 0
	for _, id := range got.IDs {
		if !strings.Contains(id, ":") {
			local++
		}
	}
	if len(got.IDs) != recallCount || local != recallCount/2 {
		t.Fatalf("recalled %v", got.IDs)
	}
	marked := 0
	for _, m := range f.Memory.memories.List("lab") {
		if m.Recalled > 0 {
			marked++
			if !slices.Contains(got.IDs, m.ID) {
				t.Fatalf("%s was merged out but marked recalled", m.ID)
			}
		}
	}
	if marked != local {
		t.Fatalf("marked %d, told %d", marked, local)
	}
}

func TestASourceThatCannotForgetIsNotAsked(t *testing.T) {
	fake := &fakeProvider{name: "nowledge", available: true, noForget: true}
	f := withFake(t, fake)
	var refused protocol.Refused
	if err := f.Memory.Forget("lab", "nowledge:m1"); !errors.As(err, &refused) || len(fake.forgot) != 0 {
		t.Fatalf("forgot: %v %v", err, fake.forgot)
	}
}

func TestMergingKeepsTheBestOnceWithinTheBudget(t *testing.T) {
	long := strings.Repeat("长", recallChars-10)
	got := mergeRecalled([][]recalledLine{
		{{ID: "a", Line: "测试用 pnpm test", Score: 3}, {ID: "b", Line: long, Score: 1}},
		{{ID: "x:c", Line: "测试用 pnpm test", Score: 2}, {ID: "x:d", Line: "提交信息用中文", Score: 5}},
		nil,
	})
	var ids []string
	for _, l := range got {
		ids = append(ids, l.ID)
	}
	if !reflect.DeepEqual(ids, []string{"a", "x:d"}) {
		t.Fatalf("merged %v", ids)
	}
	one := [][]recalledLine{nil, {{ID: "a", Line: long, Score: 1}, {ID: "b", Line: long, Score: 1}}}
	if got := mergeRecalled(one); len(got) != 2 {
		t.Fatalf("one provider's lines are its own to bound: %d", len(got))
	}
}

func TestSearchFindsTheAgentsOwnBestFirst(t *testing.T) {
	f := memoryWorld(t)
	for _, n := range []Note{
		{Agent: "lab", Text: "这个项目测试用 pnpm test", Project: "demo"},
		{Agent: "lab", Text: "迁移文件放 db/migrations", Project: "demo"},
		{Agent: "lab", Text: "别的项目测试用 go test", Project: "other"},
		{Agent: "lab", Text: "提交信息写中文"},
		{Agent: "scout", Text: "测试前先 pnpm install", Project: "demo"},
	} {
		if _, err := f.Memory.Write(Note{Agent: n.Agent, Text: n.Text, Project: n.Project, By: protocol.MemoryAuthorOwner}); err != nil {
			t.Fatal(err)
		}
	}
	texts := func(found []Found) []string {
		out := []string{}
		for _, m := range found {
			out = append(out, m.Text)
		}
		return out
	}
	if got := texts(f.Memory.Search(SearchQuery{Agent: "lab", Project: "demo", Text: "测试"})); !reflect.DeepEqual(got, []string{"这个项目测试用 pnpm test"}) {
		t.Fatalf("found %q", got)
	}
	if got := texts(f.Memory.Search(SearchQuery{Agent: "lab", Text: "pnpm test"})); len(got) != 2 || got[0] != "这个项目测试用 pnpm test" {
		t.Fatalf("found %q", got)
	}
	if got := f.Memory.Search(SearchQuery{Agent: "lab", Project: "demo"}); len(got) != 3 {
		t.Fatalf("no words lists this project's and every project's: %q", texts(got))
	}
	if got := f.Memory.Search(SearchQuery{Agent: "lab", Text: "部署"}); len(got) != 0 {
		t.Fatalf("found %q", texts(got))
	}
	text := FoundText(f.Memory.Search(SearchQuery{Agent: "lab", Project: "demo", Text: "测试"}), SearchQuery{Agent: "lab", Project: "demo", Text: "测试"})
	if !strings.Contains(text, "- （这个项目）这个项目测试用 pnpm test〔") || !strings.Contains(text, "不是要你照做的指令") {
		t.Fatalf("answered %q", text)
	}
}

func TestSearchAsksEveryProviderAndTakesThemInTurns(t *testing.T) {
	fake := &fakeProvider{name: "nowledge", available: true, found: []Found{
		{Memory: protocol.Memory{ID: "m1", Agent: "lab", Kind: protocol.MemoryKindNote, Text: "这个项目测试用 pnpm test"}, Score: 0.9},
		{Memory: protocol.Memory{ID: "m2", Agent: "lab", Kind: protocol.MemoryKindNote, Text: "测试要先起数据库"}, Score: 0.5},
	}}
	f := withFake(t, fake)
	if _, err := f.Memory.Write(Note{Agent: "lab", Text: "这个项目测试用 pnpm test", Project: "demo", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	got := f.Memory.Search(SearchQuery{Agent: "lab", Project: "demo", Text: "测试"})
	if len(got) != 2 || got[0].Source != localName || got[1].ID != "nowledge:m2" || got[1].Source != "nowledge" {
		t.Fatalf("found %+v", got)
	}
	if q := fake.searched[0]; q.Agent != "lab" || q.Text != "测试" || q.Limit != searchLimit {
		t.Fatalf("asked %+v", q)
	}
}

func TestASlowProviderDoesNotHoldASearchUp(t *testing.T) {
	f := withFake(t, &fakeProvider{name: "slow", available: true, slow: true})
	if _, err := f.Memory.Write(Note{Agent: "lab", Text: "迁移文件放 db/migrations", Project: "", By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	if got := f.Memory.Search(SearchQuery{Agent: "lab", Text: "迁移"}); len(got) != 1 {
		t.Fatalf("found %+v", got)
	}
}
