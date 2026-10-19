package issue

import (
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestIssueTitleAndJob(t *testing.T) {
	title, description := splitJob("\n  写打卡  \n\n细节在 README\n还有测试\n")
	testkit.Eq(t, [2]string{title, description}, [2]string{"写打卡", "细节在 README\n还有测试"})
	testkit.Eq(t, issueJob(protocol.Issue{Title: title, Description: description}), "写打卡\n\n细节在 README\n还有测试")
	testkit.Eq(t, issueJob(protocol.Issue{Title: "只有标题"}), "只有标题")
	title, description = splitJob("  ")
	testkit.Eq(t, [2]string{title, description}, [2]string{"", ""})
}

// Whoever works it is told how the owner will judge it, after the words.
func TestTheJobCarriesItsCriteria(t *testing.T) {
	job := issueJob(protocol.Issue{Title: "改拖卡", Description: "为什么：\n旧接口", Criteria: []string{"拖到待办就开工", "测试通过"}})
	testkit.Eq(t, job, "改拖卡\n\n为什么：\n旧接口\n\n"+criteriaHead+"\n- 拖到待办就开工\n- 测试通过")
	testkit.Eq(t, issueJob(protocol.Issue{Title: "只有标题"}), "只有标题", "no criteria, nothing added")
}

// The last json block with a title is the draft; lists may come as one string; what does not read says why.
func TestDraftsAreReadFromTheLastBlock(t *testing.T) {
	said := "看过了。\n\n```json\n{\"title\": \"旧的\"}\n```\n\n要问主人：端口用哪个？\n\n```json\n" +
		`{"title": " 看板拖卡改用 issue.status ", "why": "旧接口收不了", "todo": ["改 board.dart", " "], "criteria": "拖到待办就开工", "notDoing": [], "files": ["app/lib/workbench/issues/board.dart"]}` +
		"\n```\n\n结论：写好了"
	d, problem := parseDraft(said)
	testkit.Eq(t, problem, "", "read")
	testkit.Eq(t, d.Title, "看板拖卡改用 issue.status", "the last block, trimmed")
	testkit.Eq(t, d.Criteria.kept(), []string{"拖到待办就开工"}, "one string is one criterion")
	testkit.Eq(t, draftDescription(d), "为什么：\n旧接口收不了\n\n要做的：\n- 改 board.dart\n\n可能涉及：\n- app/lib/workbench/issues/board.dart", "fixed headings, empty ones left out")

	for name, c := range map[string]struct{ said, problem string }{
		"no block":   {"草稿写好了", "没找到草稿"},
		"not json":   {"```json\n{title: 1}\n```", "json 读不了"},
		"no title":   {"```json\n{\"why\": \"x\"}\n```", "草稿没有标题"},
		"a bad list": {"```json\n{\"title\": \"x\", \"todo\": [1]}\n```", "json 读不了"},
	} {
		if _, problem := parseDraft(c.said); !strings.HasPrefix(problem, c.problem) {
			t.Errorf("%s: %q", name, problem)
		}
	}
	if d, problem := parseDraft("```json\n{\"title\": \"x\"}\n```\n```\n不是 json\n```"); problem != "" || d.Title != "x" {
		t.Errorf("a later block that does not read leaves the earlier draft: %q %q", d.Title, problem)
	}
}

// The first draft starts from the owner's word; a redraft carries the draft so far, and an answer the questions it answers.
func TestDraftBriefs(t *testing.T) {
	first := draftBrief(protocol.Issue{Title: "新工单"}, "看板拖卡还在调旧接口", "board")
	for _, want := range []string{draftOpening, "项目：board", "主人想做的：看板拖卡还在调旧接口", "```json", `"criteria"`, "要问主人："} {
		if !strings.Contains(first, want) {
			t.Errorf("first draft lacks %q", want)
		}
	}
	if strings.Contains(first, "上一版草稿") {
		t.Error("a first draft has no draft so far")
	}
	drafted := protocol.Issue{Title: "看板拖卡改用 issue.status", Description: "为什么：\n旧接口", Criteria: []string{"拖到待办就开工"}, Asks: []string{"端口用哪个？"}}
	answer := draftBrief(drafted, "用 8797", "board")
	for _, want := range []string{"上一版草稿", "标题：看板拖卡改用 issue.status", "为什么：\n旧接口", "- 拖到待办就开工", "你上一版问主人的：\n- 端口用哪个？", "主人的回答：用 8797"} {
		if !strings.Contains(answer, want) {
			t.Errorf("an answer lacks %q", want)
		}
	}
	drafted.Asks = nil
	again := draftBrief(drafted, "也改测试", "board")
	if !strings.Contains(again, "主人这次说：也改测试") || strings.Contains(again, "主人的回答") {
		t.Errorf("a redraft with a word: %s", again)
	}
}

func TestNextTaskID(t *testing.T) {
	testkit.Eq(t, nextTaskID(nil), "p1")
	testkit.Eq(t, nextTaskID([]string{"p3", "p12", "p9"}), "p13")
	testkit.Eq(t, nextTaskID([]string{"p3", "px", "p 7 ", "p-9", "p0x10", "p1.5", "q40"}), "p4", "only p and a whole number count")
}
