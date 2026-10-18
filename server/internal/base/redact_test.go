package base

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestRedactTakesSecretsOutOfText(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"用 sk-abcdefghijklmnop1234 调 DeepSeek", "用 [redacted] 调 DeepSeek"},
		{"DEEPSEEK_API_KEY=sk-abcdefghijklmnop1234", "DEEPSEEK_API_KEY=[redacted]"},
		{`{"api_key": "abc123def456"}`, `{"api_key": "[redacted]"}`},
		{"export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ", "export GITHUB_TOKEN=[redacted]"},
		{"Authorization: Bearer hb_w1_AAAABBBBCCCCDDDDEEEE", "Authorization: Bearer [redacted]"},
		{"password: hunter2hunter2", "password: [redacted]"},
		{"AKIAABCDEFGHIJKLMNOP 是 AWS 的", "[redacted] 是 AWS 的"},
		{"xoxb-1234567890-abcdefghij", "[redacted]"},
		{"-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----", "[redacted]"},
		{"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "[redacted]"},
	} {
		if got := Redact(c.in); got != c.want {
			t.Errorf("Redact(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	for _, kept := range []string{
		"这个项目测试用 pnpm test",
		"登录态统一走 refreshSession()",
		"the token is refreshed every hour",
		"迁移文件放 db/migrations，表名用单数",
		"task-1234567890abcdef 是工单号",
	} {
		if got := Redact(kept); got != kept {
			t.Errorf("Redact(%q) = %q: nothing secret there", kept, got)
		}
	}
}

func TestTheLogIsRedacted(t *testing.T) {
	var out bytes.Buffer
	logger := log.New(RedactingWriter(&out), "", 0)
	logger.Printf("vibevalley: the key sk-abcdefghijklmnop1234 was refused")
	if got := out.String(); strings.Contains(got, "sk-abcdefghijklmnop1234") || !strings.Contains(got, "the key [redacted] was refused") {
		t.Fatalf("logged %q", got)
	}
}
