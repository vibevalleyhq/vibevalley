//go:build !windows

package executable

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Ported from tests/process.test.ts.

func collectLines(p *LineProcess) (func() []string, chan string) {
	var mu sync.Mutex
	var lines []string
	each := make(chan string, 64)
	p.OnLine(func(line string) {
		mu.Lock()
		lines = append(lines, line)
		mu.Unlock()
		each <- line
	})
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), lines...)
	}, each
}

func TestLineBufferingJoinsPartialChunks(t *testing.T) {
	p, err := Spawn("sh", []string{"-c", `printf 'a\nb'; sleep 0.03; printf 'c\nd\n'`}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	lines, _ := collectLines(p)
	var mu sync.Mutex
	var codes []string
	p.OnExit(func(code *int) {
		mu.Lock()
		defer mu.Unlock()
		if code == nil {
			codes = append(codes, "nil")
		} else {
			codes = append(codes, strconv.Itoa(*code))
		}
	})
	waitExited(t, p, 5*time.Second)
	if got := strings.Join(lines(), ","); got != "a,bc,d" {
		t.Fatalf("lines = %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(codes, ",") != "0" {
		t.Fatalf("codes = %v", codes)
	}
}

func TestLineBufferingKeepsUTF8SplitAcrossChunks(t *testing.T) {
	node := requireNode(t)
	// One byte per write, with a pause, so the multibyte characters arrive split.
	source := `
		const bytes = Buffer.from(JSON.stringify({ text: "hello 你好🌊" }) + "\n");
		let offset = 0;
		const timer = setInterval(() => {
			if (offset === bytes.length) { clearInterval(timer); return; }
			process.stdout.write(bytes.subarray(offset, ++offset));
		}, 2);
	`
	p, err := Spawn(node, []string{"-e", source}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { p.Kill(); <-p.Exited() }()
	_, each := collectLines(p)
	select {
	case line := <-each:
		if line != `{"text":"hello 你好🌊"}` {
			t.Fatalf("line = %q", line)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no line")
	}
}

func TestExitFiresExactlyOnceWithTheCode(t *testing.T) {
	p, err := Spawn("sh", []string{"-c", "exit 3"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var codes []int
	p.OnExit(func(code *int) { mu.Lock(); codes = append(codes, *code); mu.Unlock() })
	waitExited(t, p, 5*time.Second)
	// A handler added after the exit still fires, once.
	late := make(chan *int, 2)
	p.OnExit(func(code *int) { late <- code })
	select {
	case code := <-late:
		if code == nil || *code != 3 {
			t.Fatalf("late code = %v", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the late handler never fired")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(codes) != 1 || codes[0] != 3 {
		t.Fatalf("codes = %v", codes)
	}
	if code := p.ExitCode(); code == nil || *code != 3 || !p.HasEnded() {
		t.Fatalf("exit code = %v ended = %v", code, p.HasEnded())
	}
}

func TestMissingExecutableFailsLoudly(t *testing.T) {
	p, err := Spawn("/nonexistent/oar-fixture-binary", nil, LineOptions{})
	var spawnErr *SpawnError
	if p != nil || !errors.As(err, &spawnErr) || spawnErr.Command != "/nonexistent/oar-fixture-binary" {
		t.Fatalf("process %v err %v", p, err)
	}
}

func TestWriteReachesStdinAndKillTearsDown(t *testing.T) {
	p, err := Spawn("cat", nil, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	lines, each := collectLines(p)
	var mu sync.Mutex
	exits := 0
	p.OnExit(func(*int) { mu.Lock(); exits++; mu.Unlock() })
	p.Write("hello\n")
	select {
	case <-each:
	case <-time.After(3 * time.Second):
	}
	p.Kill()
	waitExited(t, p, 5*time.Second)
	if strings.Join(lines(), ",") != "hello" {
		t.Fatalf("lines = %q", lines())
	}
	mu.Lock()
	defer mu.Unlock()
	if exits != 1 {
		t.Fatalf("exits = %d", exits)
	}
}

func TestKillGraceFromEnv(t *testing.T) {
	cases := []struct {
		value *string
		want  time.Duration
	}{
		{nil, KillGrace},
		{ptr(""), KillGrace},
		{ptr(" "), KillGrace},
		{ptr("250"), 250 * time.Millisecond},
		{ptr("0"), 0},
		{ptr("-1"), KillGrace},
		{ptr("soon"), KillGrace},
	}
	for _, c := range cases {
		if c.value == nil {
			t.Setenv("OAR_KILL_GRACE_MS", "")
			_ = os.Unsetenv("OAR_KILL_GRACE_MS")
		} else {
			t.Setenv("OAR_KILL_GRACE_MS", *c.value)
		}
		if got := KillGraceFromEnv(); got != c.want {
			t.Fatalf("OAR_KILL_GRACE_MS=%v: %v, want %v", c.value, got, c.want)
		}
	}
}

func TestKillGraceFromEnvRefusesInfinity(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "Infinity")
	if got := KillGraceFromEnv(); got != KillGrace {
		t.Fatalf("core gap: KillGraceFromEnv parses \"Infinity\" with strconv.ParseFloat and converts +Inf to a Duration (%v); TS falls back to the 10 s default. Needed: reject non-finite values (math.IsInf/IsNaN) in KillGraceFromEnv.", got)
	}
}

func ptr(value string) *string { return &value }

// killTree spawns the fake agent with a grandchild, kills it twice (Kill is
// idempotent) and reports the exit code, how long the kill took, and what is gone.
func killTree(t *testing.T, ignoreSigterm bool) (code *int, elapsed time.Duration, goneAgent, goneGrandchild bool) {
	node := requireNode(t)
	probe := newTreeProbe(t, treeProbeOptions{ignoreSigterm: ignoreSigterm})
	p, err := Spawn(node, []string{fixture(t, "fake-agent-process.mjs")}, LineOptions{Env: probe.env})
	if err != nil {
		t.Fatal(err)
	}
	tree := probe.tree()
	started := time.Now()
	p.Kill()
	p.Kill()
	waitExited(t, p, 10*time.Second)
	elapsed = time.Since(started)
	return p.ExitCode(), elapsed, gone(tree.Agent, 5*time.Second), gone(tree.Grandchild, 5*time.Second)
}

func TestKillTakesTheProcessGroup(t *testing.T) {
	_, _, agent, grandchild := killTree(t, false)
	if !agent || !grandchild {
		t.Fatalf("gone = %v %v", agent, grandchild)
	}
}

func TestKillSIGKILLsAGroupThatIgnoresSIGTERMAfterTheGrace(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	code, elapsed, agent, grandchild := killTree(t, true)
	if code != nil {
		t.Fatalf("code = %d, want a signal", *code)
	}
	grace := 300 * time.Millisecond
	if elapsed < grace*8/10 || elapsed >= grace+2*time.Second {
		t.Fatalf("elapsed = %v", elapsed)
	}
	if !agent || !grandchild {
		t.Fatalf("gone = %v %v", agent, grandchild)
	}
}

func TestKillAfterExitSignalsNothing(t *testing.T) {
	// The child leaves a member of its group behind and exits; a late kill
	// must not reach the group through the reaped pid.
	p, err := Spawn("sh", []string{"-c", "sleep 60 >/dev/null 2>&1 & echo $!"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, each := collectLines(p)
	var leftover int
	select {
	case line := <-each:
		leftover, err = strconv.Atoi(line)
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no pid")
	}
	defer func() { _ = syscall.Kill(leftover, syscall.SIGKILL) }()
	waitExited(t, p, 5*time.Second)
	if code := p.ExitCode(); code == nil || *code != 0 {
		t.Fatalf("code = %v", code)
	}
	p.Kill()
	if gone(leftover, 300*time.Millisecond) {
		t.Fatal("the leftover was signalled")
	}
}

func TestKillTreeTakesAToolThatLeftTheGroupWhenTheChildStops(t *testing.T) {
	node := requireNode(t)
	t.Setenv("OAR_KILL_GRACE_MS", "5000")
	probe := newTreeProbe(t, treeProbeOptions{detachTool: true})
	p, err := Spawn(node, []string{fixture(t, "fake-agent-process.mjs")}, LineOptions{Env: probe.env, KillTree: true})
	if err != nil {
		t.Fatal(err)
	}
	tree := probe.tree()
	if entry, ok := ReadProcessTable()[tree.Grandchild]; !ok || entry.Pgid != tree.Grandchild {
		t.Fatalf("the tool should lead a group of its own: %+v", entry)
	}
	started := time.Now()
	p.Kill()
	waitExited(t, p, 10*time.Second)
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Fatalf("the deadline ended it, not the child's own exit: %v", elapsed)
	}
	if !gone(tree.Agent, 5*time.Second) || !gone(tree.Grandchild, time.Second) {
		t.Fatal("the child or its tool survived")
	}
}

func TestKillTreeSIGKILLTakesToolsStartedAfterTheKillBegan(t *testing.T) {
	node := requireNode(t)
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	probe := newTreeProbe(t, treeProbeOptions{ignoreSigterm: true, detachTool: true, lateTool: true})
	p, err := Spawn(node, []string{fixture(t, "fake-agent-process.mjs")}, LineOptions{Env: probe.env, KillTree: true})
	if err != nil {
		t.Fatal(err)
	}
	tree := probe.tree()
	p.Kill()
	late := probe.lateTool()
	waitExited(t, p, 10*time.Second)
	if code := p.ExitCode(); code != nil {
		t.Fatalf("code = %d, want a signal", *code)
	}
	if !gone(tree.Agent, 5*time.Second) || !gone(tree.Grandchild, time.Second) || !gone(late, time.Second) {
		t.Fatal("the child, its tool or the late tool survived")
	}
}

func TestWriteAfterKillIsDropped(t *testing.T) {
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	p, err := Spawn("sh", []string{"-c", "trap '' TERM; while :; do sleep 1; done"}, LineOptions{})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	p.Kill()
	p.Write("late\n")
	waitExited(t, p, 5*time.Second)
}
