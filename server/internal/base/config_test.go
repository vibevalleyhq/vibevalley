package base

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDBPathFrom(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{"": "", "memory": ":memory:", dir: filepath.Join(dir, "vibevalley.db"), "/x/vibevalley.db": "/x/vibevalley.db"}
	for in, want := range cases {
		if got := dbPathFrom(in); got != want {
			t.Errorf("dbPathFrom(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfigDefaultsThenFileThenEnvironment(t *testing.T) {
	home := t.TempDir()
	t.Setenv("VIBEVALLEY_HOME", home)
	c, err := LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if c.Home != home || c.Port != 8787 || c.Project.MaxSessions != 3 || c.DB() != filepath.Join(home, "vibevalley.db") {
		t.Fatalf("no file: %+v", c)
	}
	yaml := "port: 9000\nsession:\n  stall_seconds: 60\nproject: { max_sessions: 5 }\ngit_emails: [a@x, b@x]\ndb: memory\n"
	if err := os.WriteFile(filepath.Join(home, "vibevalley.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VIBEVALLEY_PORT", "9100")
	t.Setenv("VIBEVALLEY_PATROL_HEARTBEAT_MINUTES", "0.5")
	t.Setenv("DEEPSEEK_API_KEY", "sk-env")
	c, err = LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 9100 || c.Session.StallSeconds != 60 || c.Project.MaxSessions != 5 || c.Patrol.HeartbeatMinutes != 0.5 ||
		c.DeepSeek.APIKey != "sk-env" || len(c.GitEmails) != 2 || c.DBPath != ":memory:" || c.Schedule.TickMs != 20_000 {
		t.Fatalf("file and environment: %+v", c)
	}
	t.Setenv("VIBEVALLEY_GIT_EMAILS", "c@x,d@x,e@x")
	if c, _ = LoadConfig(""); len(c.GitEmails) != 3 {
		t.Fatalf("emails from the environment: %q", c.GitEmails)
	}
}

func TestConfigRefusesWhatItCannotRead(t *testing.T) {
	t.Setenv("VIBEVALLEY_HOME", t.TempDir())
	if _, err := LoadConfig(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("a named file that is not there")
	}
	t.Setenv("VIBEVALLEY_PORT", "eighty")
	if _, err := LoadConfig(""); err == nil {
		t.Fatal("a port that is not a number")
	}
}

func TestServerIdentityCannotBeConfiguredOutsideLoopback(t *testing.T) {
	t.Setenv("VIBEVALLEY_HOME", t.TempDir())
	t.Setenv("VIBEVALLEY_HOST", "0.0.0.0")
	t.Setenv("VIBEVALLEY_PORT", "9100")
	c, err := LoadConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ServerAddress(); got != "127.0.0.1:9100" {
		t.Fatal(got)
	}
}
