package issue

import (
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

func TestNextTaskID(t *testing.T) {
	testkit.Eq(t, nextTaskID(nil), "p1")
	testkit.Eq(t, nextTaskID([]string{"p3", "p12", "p9"}), "p13")
	testkit.Eq(t, nextTaskID([]string{"p3", "px", "p 7 ", "p-9", "p0x10", "p1.5", "q40"}), "p4", "only p and a whole number count")
}
