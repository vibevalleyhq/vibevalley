// Command oar observes and runs installed agent runtimes (packages/cli).
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"vibevalley/pkg/smith/community/dsh"
	"vibevalley/pkg/smith/community/morph"
	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/runtimes/defaults"
)

// version is the CLI's version; release builds set it with -ldflags "-X vibevalley/pkg/smith/cli.version=…".
var version = "0.59.1"

// cli holds what one invocation writes to and reads from.
type cli struct {
	name     string
	stdout   io.Writer
	stderr   io.Writer
	stdin    io.Reader
	registry *oar.RuntimeRegistry
	exitCode int
}

// Options is where Main runs: the runtimes it knows and the command it is called by in usage and examples.
type Options struct {
	// "oar" when empty.
	Name     string
	Registry *oar.RuntimeRegistry
}

// Main runs one invocation over the standard streams and returns its exit code; whatever a runtime left running is
// taken down before it returns, as Go has no exit hook.
func Main(argv []string, options Options) int {
	app := &cli{name: options.Name, stdout: os.Stdout, stderr: os.Stderr, stdin: os.Stdin, registry: options.Registry}
	if app.name == "" {
		app.name = "oar"
	}
	code := app.main(argv)
	executable.KillOwned()
	shared.RemovePrivateTempDirs()
	return code
}

// Runtimes is OAR's built-in runtimes plus the community ones, as packages/cli/src/runtimes.ts.
func Runtimes() []oar.Runtime { return append(defaults.Runtimes(), morph.Runtime(), dsh.Runtime()) }

const usage = `Usage: %s [options] [command]

Observe and run installed agent runtimes

Options:
  -V, --version                      output the version number
  -h, --help                         display help for command

Commands:
  list                               List registered runtimes and their capabilities
  installation|detect [runtime]      Probe local runtime installation without account or usage I/O
  usage [runtime]                    Read account usage for each available installation
  skills [runtime]                   Query native skills inventory for a working directory (JSON)
  commands [runtime]                 Query native commands inventory for a working directory (JSON)
  mcps [runtime]                     Query native mcps inventory for a working directory (JSON)
  tools [runtime]                    Query native tools inventory for a working directory (JSON)
  models [runtime]                   List models each available installation can run right now
  upgrade [runtime]                  Upgrade installed runtimes with their own updaters; --check only reports
  login [runtime]                    Log a runtime in through its own login; --status only reports whether each is logged in
  logout <runtime>                   Log a runtime out through its own logout; its status query must then read logged out
  mcp                                Serve subagents over MCP on stdio: let an agent delegate tasks to other runtimes
  run <runtime> <prompt>             Run one turn in a fresh (or --resume'd) session and show its progress
`

func (c *cli) main(argv []string) int {
	if len(argv) == 0 || argv[0] == "-h" || argv[0] == "--help" || argv[0] == "help" {
		fmt.Fprintf(c.stdout, usage, c.name)
		return 0
	}
	if argv[0] == "-V" || argv[0] == "--version" {
		fmt.Fprintln(c.stdout, version)
		return 0
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	command, rest := argv[0], argv[1:]
	var err error
	switch command {
	case "list":
		err = c.list()
	case "installation", "detect":
		err = c.installation(ctx, rest)
	case "usage":
		err = c.usage(ctx, rest)
	case "skills", "commands", "mcps", "tools":
		err = c.inventory(ctx, command, rest)
	case "models":
		err = c.models(ctx, rest)
	case "upgrade":
		err = c.upgrade(ctx, rest)
	case "login":
		err = c.login(ctx, rest)
	case "logout":
		err = c.logout(ctx, rest)
	case "mcp":
		err = c.mcp(ctx, rest)
	case "run":
		err = c.run(ctx, rest)
	default:
		fmt.Fprintf(c.stderr, "error: unknown command '%s'\n", command)
		return 1
	}
	if err != nil {
		fmt.Fprintf(c.stderr, "error: %s\n", err)
		return 1
	}
	return c.exitCode
}

// selected is every registered runtime for "" or "all", else the named one.
func (c *cli) selected(id string) ([]oar.Runtime, error) {
	if id == "" || id == "all" {
		return c.registry.List(), nil
	}
	runtime, err := c.registry.Require(id)
	if err != nil {
		return nil, err
	}
	return []oar.Runtime{runtime}, nil
}

// pretty is JSON.stringify(value, null, 2).
func pretty(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
	return out.String()
}

// compact is JSON.stringify(value).
func compact(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	return strings.TrimSuffix(out.String(), "\n")
}

// failure is a runtime whose probe or read failed: its reason in place of its report.
type failure struct {
	RuntimeID string `json:"runtimeId"`
	Error     string `json:"error"`
}

// readEach reads every runtime at once; one that fails reports its error while the others still report.
func readEach(runtimes []oar.Runtime, read func(oar.Runtime) (any, error)) []any {
	reports := make([]any, len(runtimes))
	var wg sync.WaitGroup
	for i, runtime := range runtimes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if recovered := recover(); recovered != nil {
					reports[i] = failure{RuntimeID: runtime.ID, Error: fmt.Sprint(recovered)}
				}
			}()
			report, err := read(runtime)
			if err != nil {
				reports[i] = failure{RuntimeID: runtime.ID, Error: err.Error()}
				return
			}
			reports[i] = report
		}()
	}
	wg.Wait()
	return reports
}

// printEach prints the reports as JSON; a failed runtime makes the exit code 1.
func (c *cli) printEach(reports []any) {
	for _, report := range reports {
		if _, failed := report.(failure); failed {
			c.exitCode = 1
		}
	}
	fmt.Fprint(c.stdout, pretty(reports))
}

func (c *cli) list() error {
	type row struct {
		ID           string `json:"id"`
		Session      bool   `json:"session"`
		Installation bool   `json:"installation"`
		Install      bool   `json:"install"`
		AccountUsage bool   `json:"accountUsage"`
		ListModels   bool   `json:"listModels"`
		CheckUpdate  bool   `json:"checkUpdate"`
		Upgrade      bool   `json:"upgrade"`
		Login        bool   `json:"login"`
		Logout       bool   `json:"logout"`
		AuthStatus   bool   `json:"authStatus"`
	}
	rows := []row{}
	for _, runtime := range c.registry.List() {
		rows = append(rows, row{ID: runtime.ID, Session: true, Installation: runtime.Installation != nil, Install: runtime.Install != nil,
			AccountUsage: runtime.AccountUsage != nil, ListModels: runtime.ListModels != nil, CheckUpdate: runtime.CheckUpdate != nil,
			Upgrade: runtime.Upgrade != nil, Login: runtime.Login != nil, Logout: runtime.Logout != nil, AuthStatus: runtime.AuthStatus != nil})
	}
	fmt.Fprint(c.stdout, pretty(rows))
	return nil
}

func (c *cli) installation(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, nil, nil)
	if err != nil {
		return err
	}
	id, _ := parsed.arg(0)
	runtimes, err := c.selected(id)
	if err != nil {
		return err
	}
	c.printEach(readEach(runtimes, func(runtime oar.Runtime) (any, error) {
		report := map[string]any{"runtimeId": runtime.ID, "installation": nil}
		if runtime.Installation != nil {
			snapshot, err := runtime.Installation(ctx)
			if err != nil {
				return nil, err
			}
			report["installation"] = snapshot
		}
		return report, nil
	}))
	return nil
}

func (c *cli) usage(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, nil, nil)
	if err != nil {
		return err
	}
	id, _ := parsed.arg(0)
	runtimes, err := c.selected(id)
	if err != nil {
		return err
	}
	c.printEach(readEach(runtimes, func(runtime oar.Runtime) (any, error) {
		if runtime.AccountUsage == nil || runtime.Installation == nil {
			return map[string]any{"runtimeId": runtime.ID, "accountUsage": oar.AccountUsageSnapshot{Kind: "unsupported", Reason: "capability_unavailable"}}, nil
		}
		installation, err := runtime.Installation(ctx)
		if err != nil {
			return nil, err
		}
		if installation.Kind != "available" {
			return map[string]any{"runtimeId": runtime.ID, "installation": installation, "accountUsage": nil}, nil
		}
		usage, err := runtime.AccountUsage(ctx, installation.Available, oar.AccountUsageReadOptions{})
		if err != nil {
			return nil, err
		}
		return map[string]any{"runtimeId": runtime.ID, "accountUsage": usage}, nil
	}))
	return nil
}

func (c *cli) inventory(ctx context.Context, command string, raw []string) error {
	parsed, err := parseArgs(raw, []string{"cwd", "timeout"}, nil)
	if err != nil {
		return err
	}
	timeout, _, err := parsed.positiveMs("timeout")
	if err != nil {
		return fmt.Errorf("--timeout must be a positive integer")
	}
	cwd, _ := parsed.value("cwd")
	options := oar.InventoryOptions{Cwd: cwd, Timeout: millis(timeout)}
	id, _ := parsed.arg(0)
	runtimes, err := c.selected(id)
	if err != nil {
		return err
	}
	c.printEach(readEach(runtimes, func(runtime oar.Runtime) (any, error) {
		var snapshot *oar.InstallationSnapshot
		if runtime.Installation != nil {
			read, err := runtime.Installation(ctx)
			if err != nil {
				return nil, err
			}
			snapshot = &read
		}
		if snapshot == nil || snapshot.Kind != "available" {
			return map[string]any{"runtimeId": runtime.ID, "installation": snapshot, "inventory": nil}, nil
		}
		var result any
		switch command {
		case "skills":
			result, err = runtime.Skills(ctx, snapshot.Available, options)
		case "commands":
			result, err = runtime.Commands(ctx, snapshot.Available, options)
		case "mcps":
			result, err = runtime.MCPServers(ctx, snapshot.Available, options)
		default:
			result, err = runtime.Tools(ctx, snapshot.Available, options)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"runtimeId": runtime.ID, "inventory": result}, nil
	}))
	return nil
}
