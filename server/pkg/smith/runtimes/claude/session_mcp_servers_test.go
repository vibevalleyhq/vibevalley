//go:build wip_b

package claude

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-session-mcp-servers.test.ts.

var mcpInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.292"}

const (
	b_stdioToken = "stdio-secret-value"
	b_header     = "Bearer header-secret-value"
)

var b_echo = oar.McpServer{Name: "echo", Command: "/usr/bin/node", Args: []string{"echo.mjs"}, Env: map[string]string{"OAR_ECHO_TOKEN": b_stdioToken}}

var b_servers = []oar.McpServer{b_echo, {Name: "remote", Type: "http", URL: "http://127.0.0.1:9/mcp", Headers: map[string]string{"Authorization": b_header}}}

var b_fifos = runtime.GOOS != "windows"

// b_spawned is the --mcp-config path of the one spawn so far ("" when none), and the whole argv.
func b_spawned(spawner *fakeSpawner) ([]string, string) {
	args := spawner.call(0).args
	index := slices.Index(args, "--mcp-config")
	if index == -1 || index+1 >= len(args) {
		return args, ""
	}
	return args, args[index+1]
}

// b_assertConfigPath: the argv holds the config's path, never a credential,
// and no --strict-mcp-config; the path is 0600, a FIFO where the platform has them.
func b_assertConfigPath(t *testing.T, args []string, config string) {
	t.Helper()
	if slices.Contains(args, "--strict-mcp-config") {
		t.Fatal("--strict-mcp-config passed")
	}
	argv := jsonText(args)
	for _, secret := range []string{b_stdioToken, b_header} {
		if strings.Contains(argv, secret) {
			t.Fatalf("argv carries %q", secret)
		}
	}
	if b_fifos {
		entry, err := os.Lstat(config)
		if err != nil {
			t.Fatal(err)
		}
		if entry.Mode()&os.ModeNamedPipe == 0 || entry.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %v", entry.Mode())
		}
	}
}

func b_exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestMcpServersReachClaudeThroughMcpConfigNeverArgv(t *testing.T) {
	ctx := testContext(t)
	spawner := useFakeSpawner(t, newFakeProcess(nil))
	session, err := Session(ctx, mcpInstallation, oar.SessionOptions{Cwd: "/work", MCPServers: b_servers})
	if err != nil {
		t.Fatal(err)
	}
	args, config := b_spawned(spawner)
	if config == "" {
		t.Fatalf("no --mcp-config in %v", args)
	}
	b_assertConfigPath(t, args, config)
	// What claude reads; on a FIFO it is never on a disk.
	data, err := os.ReadFile(config)
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, jsonx.ParseRecord(data), `{"mcpServers":{
		"echo":{"args":["echo.mjs"],"command":"/usr/bin/node","env":{"OAR_ECHO_TOKEN":"stdio-secret-value"},"type":"stdio"},
		"remote":{"headers":{"Authorization":"Bearer header-secret-value"},"type":"http","url":"http://127.0.0.1:9/mcp"}}}`)
	if b_fifos {
		eventually(t, "the handoff directory to go", func() bool { return !b_exists(filepath.Dir(config)) })
	}
	_ = session.Dispose(ctx)
	if b_exists(filepath.Dir(config)) {
		t.Fatal("the config directory outlived the session")
	}
}

func TestResumePassesTheMcpConfigAgain(t *testing.T) {
	ctx := testContext(t)
	spawner := useFakeSpawner(t, newFakeProcess(func(text string, child *fakeProcess) {
		request := b_requestOf(text)
		child.emitJSON(b_controlSuccess(request["request_id"], map[string]any{}))
	}))
	session, err := Session(ctx, mcpInstallation, oar.SessionOptions{Cwd: "/work", Resume: "claude-session-1", MCPServers: b_servers})
	if err != nil {
		t.Fatal(err)
	}
	args, config := b_spawned(spawner)
	if !containsInOrder(args, "--resume", "claude-session-1") || config == "" {
		t.Fatalf("args = %v", args)
	}
	_ = session.Dispose(ctx)
}

func TestClaudeExitingBeforeItReadsTheConfigRemovesItToo(t *testing.T) {
	ctx := testContext(t)
	fake := newFakeProcess(nil)
	spawner := useFakeSpawner(t, fake)
	session, err := Session(ctx, mcpInstallation, oar.SessionOptions{Cwd: "/work", MCPServers: b_servers})
	if err != nil {
		t.Fatal(err)
	}
	_, config := b_spawned(spawner)
	if config == "" {
		t.Fatal("no config")
	}
	fake.end(intPtr(1))
	<-fake.Exited()
	if b_exists(filepath.Dir(config)) {
		t.Fatal("the config directory outlived claude")
	}
	_ = session.Dispose(ctx)
}

func TestClaudeExitingInTheMiddleOfReadingStopsTheHandoff(t *testing.T) {
	if !b_fifos {
		t.Skip("no FIFOs")
	}
	ctx := testContext(t)
	fake := newFakeProcess(nil)
	spawner := useFakeSpawner(t, fake)
	// Larger than a pipe holds, so the write is still going when the reader leaves.
	large := oar.McpServer{Name: "large", Command: "/usr/bin/node", Env: map[string]string{"OAR_LARGE": strings.Repeat("x", 1024*1024)}}
	session, err := Session(ctx, mcpInstallation, oar.SessionOptions{Cwd: "/work", MCPServers: []oar.McpServer{large}})
	if err != nil {
		t.Fatal(err)
	}
	_, config := b_spawned(spawner)
	reader, err := os.Open(config)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1024)
	read, _ := reader.Read(buffer)
	_ = reader.Close()
	if read <= 0 {
		t.Fatal("nothing arrived")
	}
	fake.end(intPtr(1))
	_ = session.Dispose(ctx)
	if b_exists(filepath.Dir(config)) {
		t.Fatal("the config directory outlived the session")
	}
}

func TestNoServersOrAnEmptyListPassNoMcpConfig(t *testing.T) {
	for _, servers := range [][]oar.McpServer{nil, {}} {
		spawner := useFakeSpawner(t, newFakeProcess(nil))
		session, err := Session(testContext(t), mcpInstallation, oar.SessionOptions{Cwd: "/work", MCPServers: servers})
		if err != nil {
			t.Fatal(err)
		}
		if _, config := b_spawned(spawner); config != "" {
			t.Fatalf("config = %s", config)
		}
		_ = session.Dispose(testContext(t))
	}
}

func TestNameGivenTwiceRefusesTheOpenBeforeClaudeStarts(t *testing.T) {
	spawner := useFakeSpawner(t, newFakeProcess(nil))
	_, err := Session(testContext(t), mcpInstallation, oar.SessionOptions{Cwd: "/work", MCPServers: []oar.McpServer{b_echo, {Name: "echo", Command: "other"}}})
	if err == nil || err.Error() != `mcpServers names "echo" twice; names are unique within a session` {
		t.Fatalf("error = %v", err)
	}
	if spawner.count() != 0 {
		t.Fatal("claude was started")
	}
}
