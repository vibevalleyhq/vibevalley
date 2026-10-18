package brain

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCronLargeStepDoesNotOverflow(t *testing.T) {
	c, err := ParseCronExpression(fmt.Sprintf("1/%d * * * * *", math.MaxInt), time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.seconds) != 1 || !c.seconds[1] {
		t.Fatalf("seconds: %v", c.seconds)
	}
}

func TestCronCrossesDSTInAbsoluteTime(t *testing.T) {
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ expr, from, want string }{
		{"0 2 * * *", "2026-03-08T01:59:59-05:00", "2026-03-09T02:00:00-04:00"},
		{"30 1 * * *", "2026-11-01T01:45:00-04:00", "2026-11-01T01:30:00-05:00"},
	}
	for _, tc := range cases {
		t.Run(tc.expr+tc.from, func(t *testing.T) {
			c, err := ParseCronExpression(tc.expr, zone)
			if err != nil {
				t.Fatal(err)
			}
			from, _ := time.Parse(time.RFC3339, tc.from)
			want, _ := time.Parse(time.RFC3339, tc.want)
			if got := c.Next(from); !got.Equal(want) {
				t.Fatalf("got %v, want %v", got, want)
			}
		})
	}
}

func TestScheduleDoesNotWakeUntilClaimIsStored(t *testing.T) {
	dir := t.TempDir()
	wakes := 0
	s := MakeSchedules(dir, func(string) { wakes++ })
	now := time.Now()
	job := Job{ID: "once", At: isoTime(now.Add(-time.Minute)), Created: isoTime(now.Add(-time.Hour))}
	if err := s.store([]Job{job}); err != nil {
		t.Fatal(err)
	}
	// A directory at the temporary file path makes the real atomic write fail.
	if err := os.Mkdir(s.file+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	s.Tick(now)
	s.Tick(now)
	if wakes != 0 {
		t.Fatalf("woke %d times without a durable claim", wakes)
	}
	if err := os.Remove(s.file + ".tmp"); err != nil {
		t.Fatal(err)
	}
	s.Tick(now)
	s.Tick(now)
	if wakes != 1 {
		t.Fatalf("woke %d times after repair", wakes)
	}
}

func TestScheduleCorruptionIsNotAnEmptyList(t *testing.T) {
	dir := t.TempDir()
	s := MakeSchedules(dir, func(string) { t.Fatal("unexpected wake") })
	damaged := []byte(`[{"id":"important"`)
	if err := os.WriteFile(s.file, damaged, 0600); err != nil {
		t.Fatal(err)
	}
	failed(t, call(t, s.Tools, "schedule", `{"name":"new","message":"work","every_minutes":5}`))
	failed(t, call(t, s.Tools, "list_schedules", `{}`))
	s.Tick(time.Now())
	got, err := os.ReadFile(s.file)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(damaged) {
		t.Fatalf("damaged file overwritten: %q", got)
	}
}

func TestSessionDoesNotImportLegacyPrompt(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "manager.json")
	current := filepath.Join(dir, "manager.jsonl")
	data := []byte(`{"content":[{"role":"user","content":"old message"}]}`)
	if err := os.WriteFile(old, data, 0600); err != nil {
		t.Fatal(err)
	}
	if got := SessionAt(current).Load(); len(got) != 0 {
		t.Fatalf("loaded legacy messages: %v", got)
	}
	if _, err := os.Stat(current); !os.IsNotExist(err) {
		t.Fatalf("created current session: %v", err)
	}
	got, err := os.ReadFile(old)
	if err != nil || string(got) != string(data) {
		t.Fatalf("changed legacy prompt: %q %v", got, err)
	}
}
