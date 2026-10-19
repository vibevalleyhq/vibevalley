package issue

// An issue's text as a job and back, whether it is closed, the next task's id, and its draft: what the drafting session
// is told and how what it hands back is read.

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

func isClosed(s protocol.IssueStatus) bool {
	return s == protocol.IssueStatusDone || s == protocol.IssueStatusCanceled
}

// The criteria go last, so whoever works it checks each one before it hands the work back.
func issueJob(t protocol.Issue) string {
	job := t.Title
	if t.Description != "" {
		job += "\n\n" + t.Description
	}
	if len(t.Criteria) > 0 {
		job += "\n\n" + criteriaHead + "\n- " + strings.Join(t.Criteria, "\n- ")
	}
	return job
}

const criteriaHead = "验收标准（主人照这几条验收；做完逐条对照，结论里说每条是怎么验的）："

func splitJob(job string) (title, description string) {
	lines := strings.Split(strings.ReplaceAll(job, "\r\n", "\n"), "\n")
	for i, line := range lines {
		if t := strings.TrimSpace(line); t != "" {
			return t, strings.TrimSpace(strings.Join(lines[i+1:], "\n"))
		}
	}
	return "", ""
}

// One more than the largest p<number> among ids; the rest do not count.
func nextTaskID(ids []string) string {
	var top int64
	for _, id := range ids {
		if digits, ok := strings.CutPrefix(id, "p"); ok {
			if n, err := strconv.ParseInt(digits, 10, 64); err == nil && n > top {
				top = n
			}
		}
	}
	return "p" + strconv.FormatInt(top+1, 10)
}

// A draft as its session hands it back, in the json block its brief asks for. A list may come as one string.
type issueDraft struct {
	Title    string     `json:"title"`
	Why      string     `json:"why"`
	Todo     draftLines `json:"todo"`
	Criteria draftLines `json:"criteria"`
	NotDoing draftLines `json:"notDoing"`
	Files    draftLines `json:"files"`
}

type draftLines []string

func (l *draftLines) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*l = draftLines{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return errors.New("要是字符串或字符串的数组")
	}
	*l = many
	return nil
}

func (l draftLines) kept() []string {
	var out []string
	for _, line := range l {
		if line = str.Trim(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

var draftBlock = regexp.MustCompile("```(?:json)?[^\\n]*\\n([\\s\\S]*?)```")

// The last block that reads as a draft with a title; the problem says why none did. The words for JSON that does not
// read are Go's.
func parseDraft(text string) (issueDraft, string) {
	blocks := draftBlock.FindAllStringSubmatch(text, -1)
	if len(blocks) == 0 {
		return issueDraft{}, "没找到草稿：要用一个 json 代码块给出"
	}
	problem := ""
	for i := len(blocks) - 1; i >= 0; i-- {
		var d issueDraft
		if err := json.Unmarshal([]byte(blocks[i][1]), &d); err != nil {
			problem = "json 读不了：" + err.Error()
			continue
		}
		if d.Title = str.Clip(d.Title, 80); d.Title == "" {
			problem = "草稿没有标题"
			continue
		}
		return d, ""
	}
	return issueDraft{}, problem
}

// The issue's description from a draft, under the same headings every time; a heading with nothing under it is left out.
func draftDescription(d issueDraft) string {
	var parts []string
	if why := str.Trim(d.Why); why != "" {
		parts = append(parts, "为什么：\n"+why)
	}
	for _, s := range []struct {
		head  string
		lines []string
	}{{"要做的：", d.Todo.kept()}, {"不做的：", d.NotDoing.kept()}, {"可能涉及：", d.Files.kept()}} {
		if len(s.lines) > 0 {
			parts = append(parts, s.head+"\n- "+strings.Join(s.lines, "\n- "))
		}
	}
	return strings.Join(parts, "\n\n")
}

// What the drafting session is told: the owner's word, the draft so far when there is one (as the owner may have edited
// it), and what it asked with the owner's answer.
func draftBrief(t protocol.Issue, word, project string) string {
	word = str.Trim(word)
	answering := word != "" && len(t.Asks) > 0
	redraft := t.Description != "" || len(t.Criteria) > 0
	example, _ := json.MarshalIndent(issueDraft{
		Title:    "看板拖卡改用 issue.status",
		Why:      "看板拖卡片还在调旧的 start 接口，挪到已完成时收不了。",
		Todo:     draftLines{"board.dart 的拖放改调 issue.status", "删掉旧接口的调用"},
		Criteria: draftLines{"把一张备选拖到待办，它开工", "flutter test test/workbench/issues_test.dart 通过"},
		NotDoing: draftLines{"不改看板的样子"},
		Files:    draftLines{"app/lib/workbench/issues/board.dart"},
	}, "", "  ")
	lines := []string{
		draftOpening,
		"",
		fmt.Sprintf("项目：%s（你现在就在它的目录里）", project),
	}
	if word != "" && !redraft {
		lines = append(lines, "主人想做的："+word)
	} else {
		lines = append(lines, "主人想做的："+t.Title)
	}
	if redraft {
		lines = append(lines, "", "上一版草稿（主人可能改过，以这一版为准）：", "标题："+t.Title)
		if t.Description != "" {
			lines = append(lines, t.Description)
		}
		if len(t.Criteria) > 0 {
			lines = append(lines, "验收标准：", "- "+strings.Join(t.Criteria, "\n- "))
		}
	}
	switch {
	case answering:
		lines = append(lines, "", "你上一版问主人的：", "- "+strings.Join(t.Asks, "\n- "), "主人的回答："+word, "", "照主人的回答再起草一版，整张重写。")
	case redraft && word != "":
		lines = append(lines, "", "主人这次说："+word, "", "照主人说的再起草一版，整张重写。")
	case redraft:
		lines = append(lines, "", "再起草一版，整张重写。")
	}
	return strings.Join(append(lines,
		"",
		"先读代码，弄清现状，再写。写的规矩：",
		"- title：一句话说清做什么，不超过 30 个字。",
		"- why：为什么要做，一两句。",
		"- todo：要做的几件事，一件一条，写到改哪里。",
		"- criteria：怎么算做完，一条一个主人能照着验的点（跑什么命令、看到什么结果、页面上是什么样）。",
		"- notDoing：这张工单不做的，免得做多了；没有就给空数组。",
		"- files：可能涉及的文件或目录。",
		"- 拿不准、要主人定的，写在代码块前面，每行以「要问主人：」开头，一行问一件事；能自己查到的不要问。问了也照你最好的猜测把草稿写完整。",
		"",
		"汇报的最后，用一个 json 代码块给出草稿，格式照这个：",
		"```json",
		string(example),
		"```",
		"代码块之后写一句结论：草稿写好了没有，还要问主人什么。",
	), "\n")
}

const draftOpening = "这一轮你只起草工单：读代码，把主人想做的事写成一张能派出去的工单，交给别的帮工去做。你不改文件、不提交；农场规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。"
