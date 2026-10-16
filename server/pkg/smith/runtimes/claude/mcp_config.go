package claude

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// SessionOptions.MCPServers reach claude as --mcp-config <path>
// (mcp-config.ts): a path, never inline JSON on argv, which every user on
// the machine can read (ps), because env and headers values are credentials.
//
// On POSIX the path is a FIFO (mode 0600, in a fresh 0700 directory from
// shared.NewPrivateTempDir), so the values never reach a disk. oar opens
// the write end without blocking once claude has opened the read end (ENXIO
// until then; polled), writes the document, closes, and removes the
// directory at once. claude 2.1.292 opens the path once at startup, waits
// for the writer when it gets there first, and keeps the config in memory.
// sea-trial/vendor/claude-mcp-config.vendor.test.ts checks this on every
// claude CI installs; if it fails, this handoff needs a new design, never a
// session that silently loses its servers. Where FIFOs are unavailable
// (Windows) the path is a 0600 file, removed when claude exits.
//
// A host that ends without disposing leaves the directory to the private
// temp backstops, and every claude launch sweeps (sweepAbandonedMcpConfigs).
// A host killed by a signal in claude's startup window leaves a claude
// blocked opening the FIFO; the sweep releases it (an empty document: claude
// reports an invalid config and exits).

// mcpConfigHandoff is how the config reaches one claude process: the
// --mcp-config path, start once claude is spawned, end once it has exited
// or failed to spawn (idempotent).
type mcpConfigHandoff struct {
	path  string
	start func()
	end   func()
}

type mcpStdioConfig struct {
	Type    string             `json:"type"`
	Command string             `json:"command"`
	Args    []string           `json:"args"`
	Env     *map[string]string `json:"env,omitempty"`
}

type mcpHTTPConfig struct {
	Type    string             `json:"type"`
	URL     string             `json:"url"`
	Headers *map[string]string `json:"headers,omitempty"`
}

// claudeMcpConfig is claude's --mcp-config document for the entries: stdio
// {type, command, args, env}, http {type, url, headers}; servers in the order given.
func claudeMcpConfig(servers []oar.McpServer) string {
	entries := make([]string, 0, len(servers))
	for _, server := range servers {
		var entry any
		if shared.IsHTTPMcpServer(server) {
			config := mcpHTTPConfig{Type: "http", URL: server.URL}
			if server.Headers != nil {
				headers := server.Headers
				config.Headers = &headers
			}
			entry = config
		} else {
			args := server.Args
			if args == nil {
				args = []string{}
			}
			config := mcpStdioConfig{Type: "stdio", Command: server.Command, Args: args}
			if server.Env != nil {
				env := server.Env
				config.Env = &env
			}
			entry = config
		}
		entries = append(entries, jsonText(server.Name)+":"+jsonText(entry))
	}
	return `{"mcpServers":{` + strings.Join(entries, ",") + `}}`
}

const mcpConfigPrefix = "oar-claude-mcp-"

// sweepAbandonedMcpConfigs runs before any claude starts, with servers or
// without: it removes what hosts that died left behind, letting a claude
// still waiting on such a FIFO go.
func sweepAbandonedMcpConfigs() {
	shared.SweepPrivateTempDirs(mcpConfigPrefix)
}

func fifoHandoff(file, content string, directory *shared.PrivateTempDir) mcpConfigHandoff {
	var ended atomic.Bool
	stopped := ended.Load
	end := func() {
		ended.Store(true)
		directory.Remove()
	}
	return mcpConfigHandoff{
		path: file,
		start: func() {
			// A failed feed (claude closed its end early) leaves claude to report
			// the config it could not read; the directory goes either way.
			go func() {
				defer end()
				_ = feedFifo(file, []byte(content), stopped)
			}()
		},
		end: end,
	}
}

// handOverMcpConfig is the handoff for these entries (sweeping as above
// first). It errors on an empty or repeated name before anything is created.
func handOverMcpConfig(servers []oar.McpServer) (mcpConfigHandoff, error) {
	if err := shared.CheckMcpServerNames(servers); err != nil {
		return mcpConfigHandoff{}, err
	}
	directory, err := shared.NewPrivateTempDir(mcpConfigPrefix)
	if err != nil {
		return mcpConfigHandoff{}, err
	}
	file := filepath.Join(directory.Path, "mcp.json")
	content := claudeMcpConfig(servers)
	if makeFifo(file) {
		return fifoHandoff(file, content, directory), nil
	}
	handle, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		_, err = handle.WriteString(content)
		if closeErr := handle.Close(); err == nil {
			err = closeErr
		}
	}
	if err != nil {
		directory.Remove()
		return mcpConfigHandoff{}, err
	}
	return mcpConfigHandoff{
		path: file,
		// claude reads the file at startup; it goes when claude exits (end).
		start: func() {},
		end:   directory.Remove,
	}, nil
}
