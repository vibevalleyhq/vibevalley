//go:build !windows

package shared

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// freshPrefix is a prefix no other test or host uses.
func freshPrefix() string {
	return fmt.Sprintf("oar-test-private-%d-%06x-", os.Getpid(), rand.Intn(1<<24))
}

func TestPrivateTempDirIs0700AndNamedForItsHost(t *testing.T) {
	prefix := freshPrefix()
	directory, err := NewPrivateTempDir(prefix)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.Base(directory.Path), prefix+strconv.Itoa(os.Getpid())+"-") {
		t.Fatalf("path = %s", directory.Path)
	}
	posix := os.PathSeparator == '/'
	if info, err := os.Stat(directory.Path); err != nil || (posix && info.Mode().Perm() != 0o700) {
		t.Fatalf("stat = %v, %v", info, err)
	}
	directory.Remove()
	directory.Remove()
	if exists(directory.Path) {
		t.Fatal("remove() left the directory")
	}
}

// Go has no exit event: the host calls RemovePrivateTempDirs on its
// shutdown path, which takes every directory still present.
func TestRemovePrivateTempDirsTakesWhatIsLeft(t *testing.T) {
	directory, err := NewPrivateTempDir(freshPrefix())
	if err != nil {
		t.Fatal(err)
	}
	RemovePrivateTempDirs()
	if exists(directory.Path) {
		t.Fatal("the backstop left the directory")
	}
	directory.Remove()
}

const helperPrefixEnv = "OAR_PRIVATE_TEMP_HELPER_PREFIX"

// TestPrivateTempHelperHost is a host process for the sweep test: it makes
// a directory, prints it, and is SIGKILLed.
func TestPrivateTempHelperHost(t *testing.T) {
	prefix := os.Getenv(helperPrefixEnv)
	if prefix == "" {
		t.Skip("helper process only")
	}
	directory, err := NewPrivateTempDir(prefix)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(directory.Path)
	_ = os.Stdout.Sync()
	_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
}

func TestSweepTakesAKilledHostsDirectoryAndKeepsARunningOnes(t *testing.T) {
	posixOnly(t)
	prefix := freshPrefix()
	cmd := exec.Command(os.Args[0], "-test.run=^TestPrivateTempHelperHost$", "-test.v")
	cmd.Env = append(os.Environ(), helperPrefixEnv+"="+prefix)
	output, err := cmd.Output()
	var exitErr *exec.ExitError
	if err == nil || !errorsAs(err, &exitErr) {
		t.Fatalf("the helper was not killed: %v\n%s", err, output)
	}
	var printed string
	for _, line := range strings.Split(string(output), "\n") {
		if strings.Contains(line, prefix) {
			printed = strings.TrimSpace(line)
		}
	}
	if printed == "" || !exists(printed) {
		t.Fatalf("the killed host left no directory: %q\n%s", printed, output)
	}
	defer func() { _ = os.RemoveAll(printed) }()
	// A directory of a host that still runs (this test's parent).
	running := filepath.Join(os.TempDir(), prefix+strconv.Itoa(os.Getppid())+"-alive")
	if err := os.Mkdir(running, 0o700); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(running) }()
	SweepPrivateTempDirs(prefix)
	if exists(printed) || !exists(running) {
		t.Fatalf("dead: %v, running: %v", exists(printed), exists(running))
	}
}

func TestRemovingReleasesAReaderBlockedOnAFifo(t *testing.T) {
	posixOnly(t)
	directory, err := NewPrivateTempDir(freshPrefix())
	if err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(directory.Path, "pipe")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	reader := exec.Command("cat", fifo)
	if err := reader.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- reader.Wait() }()
	time.Sleep(200 * time.Millisecond)
	directory.Remove()
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("cat: %v", err)
		}
	case <-time.After(5 * time.Second):
		_ = reader.Process.Kill()
		t.Fatal("still waiting")
	}
	if exists(directory.Path) {
		t.Fatal("the directory stayed")
	}
}
