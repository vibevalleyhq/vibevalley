//go:build !windows

package executable

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLinesArriveBeforeExit(t *testing.T) {
	p, err := Spawn("sh", []string{"-c", "for i in 1 2 3; do echo line$i; done; printf partial; exit 3"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var events []string
	p.OnLine(func(line string) { mu.Lock(); events = append(events, line); mu.Unlock() })
	p.OnExit(func(code *int) {
		mu.Lock()
		defer mu.Unlock()
		if code == nil {
			events = append(events, "exit:nil")
		} else {
			events = append(events, "exit:"+string(rune('0'+*code)))
		}
	})
	select {
	case <-p.Exited():
	case <-time.After(5 * time.Second):
		t.Fatal("no exit")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(events, ",") != "line1,line2,line3,partial,exit:3" {
		t.Fatalf("events = %v", events)
	}
}

func TestKillEndsGroupAndDescendants(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	p, err := Spawn("sh", []string{"-c", "trap '' TERM; sleep 30 & setsid sleep 31 2>/dev/null & echo started; wait"}, LineOptions{KillTree: true})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	var once sync.Once
	p.OnLine(func(line string) { once.Do(func() { close(started) }) })
	<-started
	time.Sleep(100 * time.Millisecond)
	descendants := DescendantsOf(ReadProcessTable(), p.Pid())
	if len(descendants) == 0 {
		t.Fatal("expected descendants")
	}
	p.Kill()
	select {
	case <-p.Exited():
	case <-time.After(5 * time.Second):
		t.Fatal("kill did not settle")
	}
	time.Sleep(200 * time.Millisecond)
	table := ReadProcessTable()
	for _, entry := range descendants {
		if current, ok := table[entry.Pid]; ok && current.Start == entry.Start {
			t.Fatalf("descendant %d survived", entry.Pid)
		}
	}
}

func TestRunTimeoutAndExitCodes(t *testing.T) {
	ok := Run(context.Background(), "sh", []string{"-c", "echo hi"}, RunOptions{})
	if !ok.OK || ok.Stdout != "hi\n" {
		t.Fatalf("ok = %+v", ok)
	}
	failed := Run(context.Background(), "sh", []string{"-c", "exit 4"}, RunOptions{})
	if failed.OK || failed.ExitCode == nil || *failed.ExitCode != 4 {
		t.Fatalf("failed = %+v", failed)
	}
	t.Setenv("OAR_KILL_GRACE_MS", "100")
	slow := Run(context.Background(), "sh", []string{"-c", "sleep 10"}, RunOptions{Timeout: 100 * time.Millisecond})
	if slow.OK || slow.ExitCode != nil || slow.Diagnostics == nil || slow.Diagnostics.Timeout == 0 {
		t.Fatalf("slow = %+v", slow)
	}
	if err := AssertRan(slow, "probe"); err == nil {
		t.Fatal("a timeout must fail AssertRan")
	}
	missing := Run(context.Background(), "/nonexistent/binary", nil, RunOptions{})
	if missing.OK || missing.Diagnostics == nil || missing.Diagnostics.Error == "" {
		t.Fatalf("missing = %+v", missing)
	}
}

func TestResources(t *testing.T) {
	p, err := Spawn("sh", []string{"-c", "sleep 5"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer p.Kill()
	resources := p.Resources()
	if resources == nil || resources.Processes < 1 || resources.RSS <= 0 {
		t.Fatalf("resources = %+v", resources)
	}
	_ = os.Getpid()
}
