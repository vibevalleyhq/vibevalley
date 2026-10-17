package issue

// An issue's text as a job and back, whether it is closed, and the next plan's id.

import (
	"strconv"
	"strings"

	"vibevalley/internal/protocol"
)

func isClosed(s protocol.IssueStatus) bool {
	return s == protocol.IssueStatusDone || s == protocol.IssueStatusCanceled
}

func issueJob(t protocol.Issue) string {
	if t.Description == "" {
		return t.Title
	}
	return t.Title + "\n\n" + t.Description
}

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
func nextPlaybookID(ids []string) string {
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
