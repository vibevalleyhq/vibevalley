package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// An old home's activities become events: each record's keys and type renamed, the head as it was, the old folder gone.
func TestActivitiesMoveToEvents(t *testing.T) {
	home := t.TempDir()
	old, now := filepath.Join(home, "activities"), filepath.Join(home, "events")
	os.MkdirAll(old, 0o755)
	os.WriteFile(filepath.Join(old, "w3.json"), []byte(`[{"n":1,"at":5,"kind":"prompt","text":"写打卡"},{"n":2,"at":6,"kind":"action","text":"跑测试","ok":true}]`), 0o644)
	os.WriteFile(filepath.Join(old, "w3.head.json"), []byte(`{"id":"w3","name":"阿郑","startedAt":5}`), 0o644)
	if err := moveActivities(old, now); err != nil {
		t.Fatal(err)
	}
	log, _ := os.ReadFile(filepath.Join(now, "w3.json"))
	head, _ := os.ReadFile(filepath.Join(now, "w3.head.json"))
	for _, want := range []string{`"seq":1`, `"time":5`, `"type":"user/message"`, `"type":"tool/call"`, `"ok":true`} {
		if !strings.Contains(string(log), want) {
			t.Fatalf("no %s in %s", want, log)
		}
	}
	if string(head) != `{"id":"w3","name":"阿郑","startedAt":5}` {
		t.Fatalf("head %s", head)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("activities/ is still there")
	}
	steps := readJournal(filepath.Join(now, "w3.json"))
	if len(steps) != 2 || steps[0].Seq != 1 || steps[1].Type != "tool/call" {
		t.Fatalf("read back %+v", steps)
	}
}
