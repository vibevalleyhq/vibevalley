//go:build wip_a

package claude

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-mcp-config-host-death.test.ts. A host killed by a
// signal before claude has read its MCP config (the startup window): no
// plaintext reaches the disk, and the claude left waiting on the FIFO goes
// when the next claude session starts (it sweeps). Real processes: the host
// is this test binary re-run as a helper calling launchClaude, claude is a
// shell script that reads its --mcp-config the way claude does (a blocking open).

const hostDeathSecret = "host-death-credential-value"

const fakeMcpClaude = `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--mcp-config" ]; then config="$2"; fi
  shift
done
printf '%s' "$config" > "$OAR_FAKE_OUT.path"
sleep 1
cat "$config" > "$OAR_FAKE_OUT.part"
mv "$OAR_FAKE_OUT.part" "$OAR_FAKE_OUT"
`

// TestHostDeathHelper is the host: it launches claude with an MCP server
// holding the secret, prints its pid and SIGKILLs itself at once. It runs
// only as the helper process.
func TestHostDeathHelper(t *testing.T) {
	command := os.Getenv("OAR_HOST_DEATH_COMMAND")
	if command == "" {
		t.Skip("helper process only")
	}
	options := oar.SessionOptions{
		Cwd:        os.Getenv("OAR_HOST_DEATH_SCRATCH"),
		Env:        map[string]*string{"OAR_FAKE_OUT": oar.String(os.Getenv("OAR_HOST_DEATH_OUT"))},
		MCPServers: []oar.McpServer{{Name: "echo", Command: "node", Env: map[string]string{"OAR_ECHO_TOKEN": hostDeathSecret}}},
	}
	if _, err := launchClaude(command, "session-1", options); err != nil {
		fmt.Println("launch failed:", err)
		os.Exit(2)
	}
	fmt.Println(os.Getpid())
	_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
	time.Sleep(time.Minute)
}

func until(done func() bool, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for !done() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	return done()
}

func exists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

func TestAHostKilledBeforeClaudeReadsLeavesNoPlaintextAndTheNextSessionLetsClaudeGo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX FIFOs")
	}
	scratch := t.TempDir()
	command := filepath.Join(scratch, "claude")
	if err := os.WriteFile(command, []byte(fakeMcpClaude), 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(scratch, "read")
	host := exec.Command(os.Args[0], "-test.run=^TestHostDeathHelper$")
	host.Env = append(os.Environ(), "OAR_HOST_DEATH_COMMAND="+command, "OAR_HOST_DEATH_SCRATCH="+scratch, "OAR_HOST_DEATH_OUT="+out)
	stdout, err := host.Output()
	status, ok := host.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("the host was not SIGKILLed: %v %s", err, stdout)
	}
	if !until(func() bool { return exists(out + ".path") }, 5*time.Second) {
		t.Fatal("claude never started")
	}
	config, err := os.ReadFile(out + ".path")
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Dir(string(config))
	hostPid := strings.TrimSpace(string(stdout))
	if lines := strings.Split(hostPid, "\n"); len(lines) > 0 {
		hostPid = strings.TrimSpace(lines[len(lines)-1])
	}
	if !strings.HasPrefix(filepath.Base(directory), "oar-claude-mcp-"+hostPid+"-") {
		t.Fatalf("directory %s is not the host's (%s)", directory, hostPid)
	}
	// What the dead host left: a FIFO, nothing that holds a byte.
	if entries, err := os.ReadDir(directory); err == nil {
		for _, entry := range entries {
			info, err := os.Lstat(filepath.Join(directory, entry.Name()))
			if err == nil && info.Mode()&os.ModeNamedPipe == 0 {
				t.Fatalf("%s is not a FIFO", entry.Name())
			}
		}
	}
	// claude waits on the FIFO, where no writer will come, until a sweep releases it.
	sweepAbandonedMcpConfigs()
	if !until(func() bool { return exists(out) }, 5*time.Second) {
		t.Fatal("the waiting claude never read")
	}
	read, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if string(read) != "" || exists(directory) {
		t.Fatalf("read %q, directory left %v", read, exists(directory))
	}
}
