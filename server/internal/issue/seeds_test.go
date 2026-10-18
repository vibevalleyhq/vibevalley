package issue

import (
	"regexp"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
	"vibevalley/pkg/x/str"
)

var goStack = protocol.ProjectStack{Name: "go", Label: "Go", Test: "go test ./...", Lint: "go vet ./...", Build: "go build ./..."}

func TestSeedCatalogIsWellFormed(t *testing.T) {
	kinds := protocol.SeedCatalog()
	if len(kinds) == 0 {
		t.Fatal("no kinds")
	}
	holes := regexp.MustCompile(`\{[^}]*\}`)
	kindIDs := map[string]bool{}
	for _, k := range kinds {
		if k.ID == "" || k.Name == "" || !strings.HasPrefix(k.Icon, "plot-") || len(k.Seeds) == 0 || kindIDs[k.ID] {
			t.Fatalf("kind %+v", k)
		}
		kindIDs[k.ID] = true
		seedIDs := map[string]bool{}
		for _, s := range k.Seeds {
			if s.ID == "" || seedIDs[s.ID] || s.Title == "" || s.Done == "" || s.Text != "" || s.Blank != nil {
				t.Fatalf("%s: seed %+v", k.ID, s)
			}
			seedIDs[s.ID] = true
			for _, hole := range holes.FindAllString(s.Title+s.Done, -1) {
				if hole != "{test}" && hole != "{lint}" && hole != "{build}" {
					t.Fatalf("%s/%s: hole %s", k.ID, s.ID, hole)
				}
			}
			// Blanks open and close in turn, never nested and never empty.
			for _, part := range []string{s.Title, s.Done} {
				open := false
				last := -1
				for i, r := range []rune(part) {
					switch r {
					case '〔':
						if open {
							t.Fatalf("%s/%s: nested blank in %q", k.ID, s.ID, part)
						}
						open, last = true, i
					case '〕':
						if !open || i == last+1 {
							t.Fatalf("%s/%s: bad blank in %q", k.ID, s.ID, part)
						}
						open = false
					}
				}
				if open {
					t.Fatalf("%s/%s: open blank in %q", k.ID, s.ID, part)
				}
			}
		}
	}
}

func TestASeedIsFilledForTheStack(t *testing.T) {
	seed := protocol.Seed{ID: "x", Title: "修一个 bug：〔现象〕", Done: "{build} 不再报错；跑一遍 {test}，再看（{lint}）"}
	got := filledSeed(seed, goStack)
	testkit.Eq(t, got.Done, "`go build ./...` 不再报错；跑一遍 `go test ./...`，再看（`go vet ./...`）")
	testkit.Eq(t, got.Text, "修一个 bug：〔现象〕\n做到什么程度算完："+got.Done)
	testkit.Eq(t, *got.Blank, protocol.SeedBlank{Start: 8, End: 12})
	testkit.Eq(t, str.Slice(got.Text, int(got.Blank.Start), int(got.Blank.End)), "〔现象〕")

	plain := filledSeed(seed, protocol.ProjectStack{})
	testkit.Eq(t, plain.Done, "构建不再报错；跑一遍测试，再看（代码检查）")

	partly := filledSeed(protocol.Seed{Title: "测试挂了就修", Done: "{build} 和 {test} 都通过"}, protocol.ProjectStack{Name: "node", Test: "bun run test"})
	testkit.Eq(t, partly.Done, "构建和 `bun run test` 都通过")
	testkit.Eq(t, partly.Blank, (*protocol.SeedBlank)(nil))
}

func TestEveryCatalogSeedFillsWithoutHoles(t *testing.T) {
	for _, stack := range []protocol.ProjectStack{goStack, {}} {
		for _, k := range sowable(protocol.SeedCatalog(), stack) {
			for _, s := range k.Seeds {
				if strings.ContainsAny(s.Text, "{}") || !strings.Contains(s.Text, "\n做到什么程度算完：") {
					t.Fatalf("%s/%s: %q", k.ID, s.ID, s.Text)
				}
				if strings.Contains(s.Title, "〔") != (s.Blank != nil) {
					t.Fatalf("%s/%s: blank %+v", k.ID, s.ID, s.Blank)
				}
			}
		}
	}
	if protocol.SeedCatalog()[0].Seeds[0].Text != "" {
		t.Fatal("filling changed the catalog")
	}
}

func TestRecentSeedsAreTheProjectsOwnSentIssues(t *testing.T) {
	issue := func(title, project string, at int64, change func(*protocol.Issue)) protocol.Issue {
		i := protocol.Issue{Title: title, Project: ptr.To(project), CreatedAt: at, Sessions: []string{"s"}}
		if change != nil {
			change(&i)
		}
		return i
	}
	all := []protocol.Issue{
		issue("修登录", "app", 1, nil),
		issue("  加  打卡 ", "app", 5, nil),
		issue("修登录", "app", 4, nil),
		issue("别的项目", "web", 9, nil),
		issue("没派过", "app", 8, func(i *protocol.Issue) { i.Sessions = nil }),
		issue("计划里的一步", "app", 8, func(i *protocol.Issue) { i.Parent = ptr.To("g") }),
		issue("定时", "app", 8, func(i *protocol.Issue) { i.Schedule = ptr.To("s1") }),
		issue("给管家", "app", 8, func(i *protocol.Issue) { i.Assignee = ptr.To(protocol.ManagerAgent) }),
		issue(strings.Repeat("长", 61), "app", 8, nil),
		issue("三", "app", 3, nil),
		issue("二", "app", 2, nil),
		issue("零", "app", 0, nil),
		issue("负", "app", -1, nil),
	}
	testkit.Eq(t, sownIn(all, "app"), []string{"加 打卡", "修登录", "三", "二", "零"})
	testkit.Eq(t, sownIn(all, "none"), []string{})
}
