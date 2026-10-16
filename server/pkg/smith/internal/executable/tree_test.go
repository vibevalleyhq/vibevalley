//go:build !windows

package executable

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Ported from tests/process-tree.test.ts and the reachable part of
// tests/process-resources.test.ts.

func pidsOf(entries []ProcessEntry) []int {
	pids := make([]int, 0, len(entries))
	for _, entry := range entries {
		pids = append(pids, entry.Pid)
	}
	sort.Ints(pids)
	return pids
}

func TestDescendantsOfEndsOnACycle(t *testing.T) {
	table := ProcessTable{}
	for _, pair := range [][2]int{{10, 1}, {11, 10}, {12, 10}, {13, 12}, {20, 1}, {21, 20}, {30, 31}, {31, 30}} {
		table[pair[0]] = ProcessEntry{Pid: pair[0], Ppid: pair[1], Pgid: pair[0], Start: "0"}
	}
	check := func(pid int, want []int) {
		t.Helper()
		got := pidsOf(DescendantsOf(table, pid))
		if len(got) != len(want) {
			t.Fatalf("descendants of %d = %v, want %v", pid, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("descendants of %d = %v, want %v", pid, got, want)
			}
		}
	}
	check(10, []int{11, 12, 13})
	check(13, nil)
	check(30, []int{31})
	check(99, nil)
}

// sleeper starts `sleep 60`; detached puts it in a session of its own. It is
// reaped in the background, so a killed one is gone, not a zombie.
func sleeper(t *testing.T, detached bool, command ...string) *exec.Cmd {
	t.Helper()
	if len(command) == 0 {
		command = []string{"sleep", "60"}
	}
	cmd := exec.Command(command[0], command[1:]...)
	if detached {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = cmd.Wait() }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	return cmd
}

func TestProcessTableShowsThisProcessItsParentAndNewChildren(t *testing.T) {
	attached := sleeper(t, false).Process.Pid
	detached := sleeper(t, true).Process.Pid
	var table ProcessTable
	if !eventually(func() bool {
		table = ReadProcessTable()
		_, a := table[attached]
		_, d := table[detached]
		return a && d
	}, 2*time.Second) {
		t.Fatal("the children are not in the table")
	}
	host, child, session := table[os.Getpid()], table[attached], table[detached]
	if host.Ppid != os.Getppid() {
		t.Fatalf("host = %+v, parent %d", host, os.Getppid())
	}
	if child.Ppid != os.Getpid() || child.Pgid != host.Pgid {
		t.Fatalf("the attached child shares this process's group: %+v (host %+v)", child, host)
	}
	if session.Ppid != os.Getpid() || session.Pgid != detached {
		t.Fatalf("the detached child leads its own group: %+v", session)
	}
	below := map[int]bool{}
	for _, entry := range DescendantsOf(table, os.Getpid()) {
		below[entry.Pid] = true
	}
	if !below[attached] || !below[detached] {
		t.Fatal("both are found below this process")
	}
	if again := ReadProcessTable()[attached]; again.Start != child.Start || child.Start == "" {
		t.Fatalf("start %q then %q", child.Start, again.Start)
	}
}

func TestProcfsReadsACommandNameWithSpacesAndParentheses(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("procfs is Linux only")
	}
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep")
	}
	command := filepath.Join(t.TempDir(), "a) (b c")
	if err := os.Symlink(sleep, command); err != nil {
		t.Fatal(err)
	}
	pid := sleeper(t, false, command, "60").Process.Pid
	if !eventually(func() bool { return ReadProcessTable()[pid].Ppid == os.Getpid() }, 2*time.Second) {
		t.Fatal("its parent is not read past the name")
	}
}

func TestKillEntriesSparesAPidWhoseStartDiffers(t *testing.T) {
	pid := sleeper(t, true).Process.Pid
	var current ProcessEntry
	if !eventually(func() bool { var ok bool; current, ok = ReadProcessTable()[pid]; return ok }, 2*time.Second) {
		t.Fatal("not in the table")
	}
	earlier := current
	earlier.Start += "-earlier"
	KillEntries([]ProcessEntry{earlier}, ReadProcessTable())
	if gone(pid, 300*time.Millisecond) {
		t.Fatal("a different start time was signalled")
	}
	KillEntries([]ProcessEntry{current}, ReadProcessTable())
	if !gone(pid, 5*time.Second) {
		t.Fatal("the same process was not")
	}
}

func TestKillEntriesTakesEachGroupNeverTheHosts(t *testing.T) {
	// A leader in a session of its own reporting a member of its group.
	leader := exec.Command("sh", "-c", "sleep 60 & echo $!; wait")
	leader.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	stdout, err := leader.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-leader.Process.Pid, syscall.SIGKILL) })
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	member, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(member, syscall.SIGKILL) })
	go func() { _ = leader.Wait() }()
	target := sleeper(t, false).Process.Pid
	sibling := sleeper(t, false).Process.Pid
	var table ProcessTable
	if !eventually(func() bool {
		table = ReadProcessTable()
		_, a := table[target]
		_, b := table[member]
		_, c := table[sibling]
		return a && b && c
	}, 2*time.Second) {
		t.Fatal("not all in the table")
	}
	host, leaderEntry, targetEntry := table[os.Getpid()], table[leader.Process.Pid], table[target]
	if targetEntry.Pgid != host.Pgid || table[member].Pgid != leader.Process.Pid {
		t.Fatalf("an attached sleeper shares the host's group; the member is in the leader's: %+v %+v", targetEntry, table[member])
	}
	KillEntries([]ProcessEntry{host, leaderEntry, targetEntry}, table)
	if !gone(leader.Process.Pid, 5*time.Second) || !gone(member, 5*time.Second) || !gone(target, 5*time.Second) {
		t.Fatal("the entries and the leader's group should go")
	}
	if gone(sibling, 300*time.Millisecond) {
		t.Fatal("the host's group was signalled")
	}
}

func TestProcessTreeResourcesCountsTheGroup(t *testing.T) {
	// A runtime stand-in leading its own group, with one child in it.
	cmd := exec.Command("sh", "-c", "sleep 60 & echo $!; wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); _ = cmd.Wait() })
	if _, err := bufio.NewReader(stdout).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	var resources *Resources
	if !eventually(func() bool {
		resources = ProcessTreeResources(cmd.Process.Pid)
		return resources != nil && resources.Processes == 2
	}, 2*time.Second) {
		t.Fatalf("resources = %+v", resources)
	}
	if resources.RSS <= 0 {
		t.Fatalf("resources = %+v", resources)
	}
	if ProcessTreeResources(1<<30) != nil {
		t.Fatal("a missing pid has no reading")
	}
}
