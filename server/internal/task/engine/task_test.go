package engine

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/testkit"
)

func ids(g []Task) []string {
	out := []string{}
	for _, t := range g {
		out = append(out, t.ID)
	}
	return out
}

func state(s State) *State { return &s }

func three(t *testing.T) []Task {
	t.Helper()
	g, problems := Add(nil, []Task{
		{ID: "read", Brief: "读 auth 的代码"},
		{ID: "fix", Brief: "改 token 过期的判断", After: []string{"read"}},
		{ID: "test", Brief: "跑 auth 的测试", After: []string{"fix"}},
	})
	if problems != nil {
		t.Fatal(problems)
	}
	return g
}

func TestAddedTasksWaitAndTheFirstIsReady(t *testing.T) {
	g := three(t)
	testkit.Eq(t, ids(Ready(g)), []string{"read"})
	testkit.Eq(t, g[0].By, BySelf, "a task is its own by default")
	testkit.Eq(t, g[0].Title, "读 auth 的代码", "the brief's head when no title")
	testkit.Eq(t, g[0].After, []string{}, "no edges is an empty list, not null")
}

func TestABatchWithAnyProblemChangesNothing(t *testing.T) {
	g := three(t)
	for _, c := range []struct {
		name string
		more []Task
		want string
	}{
		{"an id taken", []Task{{ID: "read", Brief: "再读一遍"}}, "id「read」重复了"},
		{"waits for itself", []Task{{ID: "x", Brief: "b", After: []string{"x"}}}, "「x」不能等自己"},
		{"waits for no one there", []Task{{ID: "x", Brief: "b", After: []string{"nope"}}}, "「x」要等的「nope」不存在"},
		{"not an id", []Task{{ID: "读代码", Brief: "b"}}, "不能当 id"},
		{"nothing to do", []Task{{ID: "x"}}, "没有写要做什么"},
		{"nothing at all", nil, "一件任务都没有"},
	} {
		next, problems := Add(g, c.more)
		testkit.Match(t, strings.Join(problems, "；"), c.want, c.name)
		testkit.Eq(t, ids(next), ids(g), c.name+": unchanged")
	}
	_, problems := Add(nil, []Task{{ID: "a", Brief: "b", After: []string{"b"}}, {ID: "b", Brief: "b", After: []string{"a"}}})
	testkit.Eq(t, problems, []string{"这几件互相等，成了一个圈：a、b"})
}

func TestDoneOrSkippedLetsTheNextStart(t *testing.T) {
	g := three(t)
	g, err := Update(g, "read", Change{State: state(Done), Result: new("token 在 auth/jwt.go 里判断")})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, ids(Ready(g)), []string{"fix"})
	g, _ = Update(g, "fix", Change{State: state(Skipped)})
	testkit.Eq(t, ids(Ready(g)), []string{"test"})
	testkit.Eq(t, Finished(g), false)
	g, _ = Update(g, "test", Change{State: state(Done)})
	testkit.Eq(t, Finished(g), true)
}

func TestWhatATaskMayBecome(t *testing.T) {
	g := three(t)
	g, _ = Update(g, "read", Change{State: state(Failed), Result: new("没权限读")})
	g, err := Update(g, "read", Change{State: state(Waiting), Brief: new("用 sudo 读")})
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, g[0].Tries, 1, "a retry counts")
	testkit.Eq(t, g[0].Brief, "用 sudo 读")
	g, _ = Update(g, "read", Change{State: state(Done)})
	if _, err := Update(g, "read", Change{Brief: new("再读")}); err == nil || !strings.Contains(err.Error(), "做完了") {
		t.Fatalf("a done task's brief: %v", err)
	}
	if _, err := Update(g, "read", Change{State: state(Waiting)}); err == nil {
		t.Fatal("a done task cannot go back to waiting")
	}
	if _, err := Update(g, "nope", Change{State: state(Done)}); err == nil {
		t.Fatal("no such task")
	}
	if _, err := Update(g, "fix", Change{After: &[]string{"test"}}); err == nil || !strings.Contains(err.Error(), "成了一个圈") {
		t.Fatalf("an edge that closes a circle: %v", err)
	}
}

func TestTheGraphAsTheModelReadsIt(t *testing.T) {
	g := three(t)
	g, _ = Update(g, "read", Change{State: state(Done), Result: new("在\n  jwt.go")})
	testkit.Eq(t, Text(g), strings.Join([]string{
		"任务（3 件，1 件可以做）：",
		"- [做完了] read 读 auth 的代码 → 在 jwt.go",
		"- [可以做] fix 改 token 过期的判断（等 read）",
		"- [等着] test 跑 auth 的测试（等 fix）",
	}, "\n"))
	testkit.Eq(t, Text(nil), "现在没有任务。")
}

func TestAHelpersTaskGoesOutAndComesBack(t *testing.T) {
	g, _ := Add(nil, []Task{{ID: "a", Brief: "查 A", By: ByHelper}, {ID: "b", Brief: "查 B", By: ByHelper, After: []string{"a"}}})
	g = Begin(g, "a")
	testkit.Eq(t, g[0].State, Working)
	testkit.Eq(t, len(Ready(g)), 0, "working is not ready, and b waits for a")
	g = Settle(g, "a", "超时了", true)
	testkit.Eq(t, g[0].State, Waiting, "the first failure is retried")
	testkit.Eq(t, g[0].Tries, 1)
	g = Settle(Begin(g, "a"), "a", "还是超时", true)
	testkit.Eq(t, g[0].State, Failed, "the second is not")
	g, _ = Update(g, "a", Change{State: state(Waiting)})
	g = Settle(Begin(g, "a"), "a", "A 在 x.go", false)
	testkit.Eq(t, g[0].State, Done)
	testkit.Eq(t, g[0].Result, "A 在 x.go")
	testkit.Eq(t, ids(Ready(g)), []string{"b"})
	g = Requeue(Begin(g, "b"), []string{"b"})
	testkit.Eq(t, g[1].State, Waiting, "a helper called back leaves its task waiting")
}

func stores(t *testing.T) map[string]func(owner string) Store {
	db, err := base.OpenDB(filepath.Join(t.TempDir(), "farm.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return map[string]func(string) Store{
		"database": func(owner string) Store { return NewDBStore(db, owner) },
		"memory":   func(string) Store { return &MemoryStore{} },
	}
}

func TestTheStoreKeepsTheGraphAndPutsAFinishedOneAway(t *testing.T) {
	ctx := context.Background()
	for name, open := range stores(t) {
		s := open("s1")
		g, err := s.Change(ctx, func(g []Task) ([]Task, error) {
			next, problems := Add(g, []Task{{ID: "a", Brief: "b"}, {ID: "c", Brief: "d", After: []string{"a"}, By: ByHelper}})
			if problems != nil {
				t.Fatal(problems)
			}
			return next, nil
		})
		if err != nil {
			t.Fatal(name, err)
		}
		loaded, _ := s.Load(ctx)
		testkit.Eq(t, loaded, g, name+": kept as it was, edges and all")
		if _, err := s.Change(ctx, func(g []Task) ([]Task, error) { return g, errors.New("不改了") }); err == nil {
			t.Fatal(name, ": a change that fails keeps nothing")
		}
		ended, err := s.Change(ctx, func(g []Task) ([]Task, error) {
			g, _ = Update(g, "a", Change{State: state(Done)})
			return Update(g, "c", Change{State: state(Skipped)})
		})
		if err != nil {
			t.Fatal(name, err)
		}
		testkit.Eq(t, Finished(ended), true, name+": answered as it ended")
		loaded, _ = s.Load(ctx)
		testkit.Eq(t, len(loaded), 0, name+": finished, the owner has no open graph")
	}
}

func TestOneOwnersGraphIsNotAnothers(t *testing.T) {
	ctx := context.Background()
	open := stores(t)["database"]
	if _, err := open("s1").Change(ctx, func(g []Task) ([]Task, error) {
		next, _ := Add(g, []Task{{ID: "a", Brief: "b"}})
		return next, nil
	}); err != nil {
		t.Fatal(err)
	}
	other, _ := open("s2").Load(ctx)
	testkit.Eq(t, len(other), 0)
}
