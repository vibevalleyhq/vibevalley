package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"vibevalley/pkg/smith/agents"
	"vibevalley/pkg/smith/oar"
)

// `oar mcp`: a minimal MCP server over stdio (packages/cli/src/mcp*.ts):
// initialize, ping, tools/list and tools/call over the subagent crew. Every
// tool result also says which subagents finished with unread reports.

var protocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const instructions = "Delegate tasks to subagents running on other agent runtimes (claude, codex, grok, kimi, opencode, antigravity, pi). " +
	"run starts one and waits until its turn ends. For parallel work, spawn several and collect them with wait. " +
	"A subagent sees nothing of this conversation: put everything it needs in the task. " +
	"Continue one with send, or later with run and resume set to its sessionId."

// toolInputError is a caller mistake, answered as an error result, not a protocol error.
type toolInputError struct{ message string }

func (e *toolInputError) Error() string { return e.message }

type mcpTool struct {
	name         string
	description  string
	inputSchema  any
	outputSchema any
	call         func(ctx context.Context, args map[string]any) (any, error)
}

func text(args map[string]any, key string) (string, error) {
	value, present := args[key]
	if !present || value == nil {
		return "", nil
	}
	typed, ok := value.(string)
	if !ok {
		return "", &toolInputError{key + " must be a string"}
	}
	return typed, nil
}

func required(args map[string]any, key string) (string, error) {
	value, err := text(args, key)
	if err != nil {
		return "", err
	}
	if value == "" {
		return "", &toolInputError{key + " is required"}
	}
	return value, nil
}

func spawnOptions(args map[string]any) (agents.SpawnOptions, error) {
	runtime, err := required(args, "runtime")
	if err != nil {
		return agents.SpawnOptions{}, err
	}
	task, err := required(args, "task")
	if err != nil {
		return agents.SpawnOptions{}, err
	}
	options := agents.SpawnOptions{Runtime: runtime, Task: task}
	for key, target := range map[string]*string{"name": &options.Name, "cwd": &options.Cwd, "model": &options.Model, "effort": &options.Effort, "serviceTier": &options.ServiceTier, "resume": &options.Resume} {
		value, err := text(args, key)
		if err != nil {
			return agents.SpawnOptions{}, err
		}
		*target = value
	}
	return options, nil
}

func refusal(result agents.SpawnResult) map[string]any {
	return map[string]any{"kind": "refused", "code": result.Code, "reason": result.Reason}
}

var spawnProperties = map[string]any{
	"runtime":     map[string]any{"type": "string", "description": "Runtime id, from the runtimes tool (claude, codex, grok, kimi, opencode, antigravity, pi; cursor refuses the environment a subagent needs)."},
	"task":        map[string]any{"type": "string", "description": "The task: everything the subagent needs, since it sees nothing of this conversation."},
	"name":        map[string]any{"type": "string", "description": "A short name to refer to it by."},
	"cwd":         map[string]any{"type": "string", "description": "Working directory; the server's by default."},
	"model":       map[string]any{"type": "string", "description": "Runtime-native model id."},
	"effort":      map[string]any{"type": "string", "description": "Runtime-native reasoning effort."},
	"serviceTier": map[string]any{"type": "string", "description": "Runtime-native service tier from the model catalog."},
	"resume":      map[string]any{"type": "string", "description": "A sessionId from an earlier report, to continue that conversation."},
}

func installedRows(ctx context.Context, runtimes []oar.Runtime) []any {
	rows := readEach(runtimes, func(runtime oar.Runtime) (any, error) {
		row := map[string]any{"runtime": runtime.ID, "installation": "unknown"}
		if runtime.Installation != nil {
			installation, err := runtime.Installation(ctx)
			if err != nil {
				return nil, err
			}
			row["installation"] = installation.Kind
			if installation.Kind == "available" && installation.Available.IsExecutable() && installation.Available.Version != "" {
				row["version"] = installation.Available.Version
			}
		}
		// A child carries its depth in env, so a runtime that refuses env cannot be spawned.
		if reason, refused := runtime.RefusedSessionOptions[oar.OptionEnv]; refused {
			row["spawnable"] = false
			row["reason"] = reason
		}
		return row, nil
	})
	for i, row := range rows {
		if failed, ok := row.(failure); ok {
			rows[i] = map[string]any{"runtime": failed.RuntimeID, "installation": "unknown", "error": failed.Error}
		}
	}
	return rows
}

func subagentTools(crew *agents.Subagents, runtimes []oar.Runtime) []mcpTool {
	agent := func(args map[string]any) (*agents.Subagent, error) {
		id, err := required(args, "id")
		if err != nil {
			return nil, err
		}
		found := crew.Get(id)
		if found == nil {
			return nil, &toolInputError{"no subagent " + id + "; the list tool names them"}
		}
		return found, nil
	}
	idOnly := map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string"}}, "required": []string{"id"}}
	return []mcpTool{
		{name: "runtimes", description: "List the agent runtimes this server can start and whether each is installed.",
			inputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
			call:        func(ctx context.Context, _ map[string]any) (any, error) { return installedRows(ctx, runtimes), nil }},
		{name: "run", description: "Start a subagent on another agent runtime (or resume one) and wait until its turn ends; returns its final text, outcome and sessionId. Subagents run with full permissions in their working directory.",
			inputSchema: map[string]any{"type": "object", "properties": spawnProperties, "required": []string{"runtime", "task"}}, outputSchema: runOutputSchema,
			call: func(ctx context.Context, args map[string]any) (any, error) {
				options, err := spawnOptions(args)
				if err != nil {
					return nil, err
				}
				spawned, err := crew.Spawn(ctx, options)
				if err != nil {
					return nil, err
				}
				if spawned.Kind == "refused" {
					return refusal(spawned), nil
				}
				// A cancelled call leaves the report unread, for wait or the next run.
				if report := crew.Next(ctx, spawned.Agent.Info().ID); report != nil {
					return report, nil
				}
				return spawned.Agent.Info(), nil
			}},
		{name: "spawn", description: "Start a subagent and return at once with its id; read its result later with wait. Use for several tasks in parallel.",
			inputSchema: map[string]any{"type": "object", "properties": spawnProperties, "required": []string{"runtime", "task"}},
			call: func(ctx context.Context, args map[string]any) (any, error) {
				options, err := spawnOptions(args)
				if err != nil {
					return nil, err
				}
				spawned, err := crew.Spawn(ctx, options)
				if err != nil {
					return nil, err
				}
				if spawned.Kind == "refused" {
					return refusal(spawned), nil
				}
				return spawned.Agent.Info(), nil
			}},
		{name: "send", description: "Send a subagent a message. followup (default) starts a turn when it is idle and steers its running turn otherwise; steer and queue are explicit.",
			inputSchema: map[string]any{"type": "object", "properties": map[string]any{"id": map[string]any{"type": "string"}, "message": map[string]any{"type": "string"}, "mode": map[string]any{"type": "string", "enum": []string{"followup", "steer", "queue"}}}, "required": []string{"id", "message"}},
			call: func(ctx context.Context, args map[string]any) (any, error) {
				mode, err := text(args, "mode")
				if err != nil {
					return nil, err
				}
				if mode == "" {
					mode = "followup"
				}
				if mode != "followup" && mode != "steer" && mode != "queue" {
					return nil, &toolInputError{"mode must be followup, steer or queue"}
				}
				found, err := agent(args)
				if err != nil {
					return nil, err
				}
				message, err := required(args, "message")
				if err != nil {
					return nil, err
				}
				return found.Send(ctx, message, mode)
			}},
		{name: "wait", description: "Take unread turn reports as { reports: [...] }, waiting until any selected subagent reports or timeout. Empty reports means none arrived. To gather all, call wait once per id in parallel; do not concurrently call unscoped wait, which could take those reports.",
			inputSchema: map[string]any{"type": "object", "properties": map[string]any{"ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}, "timeoutMs": map[string]any{"type": "number", "description": "Default 30000, at most 600000."}}}, outputSchema: waitOutputSchema,
			call: func(ctx context.Context, args map[string]any) (any, error) {
				options := agents.WaitOptions{Timeout: 30 * time.Second}
				if list, ok := args["ids"].([]any); ok {
					options.IDs = []string{}
					for _, id := range list {
						if text, ok := id.(string); ok {
							options.IDs = append(options.IDs, text)
						}
					}
				}
				if ms, ok := args["timeoutMs"].(float64); ok {
					ms = math.Min(math.Max(ms, 0), 600_000)
					options.Timeout = time.Duration(ms * float64(time.Millisecond))
					if ms == 0 {
						options.Timeout = -1
					}
				}
				reports := crew.Wait(ctx, options)
				if reports == nil {
					reports = []agents.SubagentReport{}
				}
				return map[string]any{"reports": reports}, nil
			}},
		{name: "list", description: "List this server's subagents as { agents, unread }, with their state and turns ended. unread names the reports wait can take; list does not consume them.",
			inputSchema: map[string]any{"type": "object", "properties": map[string]any{}}, outputSchema: listOutputSchema,
			call: func(context.Context, map[string]any) (any, error) {
				unread := []map[string]any{}
				for _, report := range crew.Unread() {
					unread = append(unread, map[string]any{"id": report.ID, "turn": report.Turn})
				}
				list := crew.List()
				if list == nil {
					list = []agents.SubagentInfo{}
				}
				return map[string]any{"agents": list, "unread": unread}, nil
			}},
		{name: "interrupt", description: "Interrupt a subagent's running turn; its report follows with the outcome.", inputSchema: idOnly,
			call: func(ctx context.Context, args map[string]any) (any, error) {
				found, err := agent(args)
				if err != nil {
					return nil, err
				}
				outcome, err := found.Interrupt(ctx)
				if err != nil {
					return nil, err
				}
				result := map[string]any{"kind": outcome.Kind}
				if outcome.Kind == oar.ResponseRejected {
					result["code"] = outcome.Code
					result["reason"] = outcome.Reason
				}
				return result, nil
			}},
		{name: "close", description: "Close a subagent and release its runtime process.", inputSchema: idOnly,
			call: func(ctx context.Context, args map[string]any) (any, error) {
				found, err := agent(args)
				if err != nil {
					return nil, err
				}
				if err := found.Close(ctx); err != nil {
					return nil, err
				}
				return found.Info(), nil
			}},
	}
}

type mcpServer struct {
	tools   []mcpTool
	crew    *agents.Subagents
	writeMu sync.Mutex
	out     io.Writer
}

func (s *mcpServer) write(message any) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	fmt.Fprintln(s.out, compact(message))
}

func (s *mcpServer) unreadNote() string {
	unread := s.crew.Unread()
	if len(unread) == 0 {
		return ""
	}
	names := make([]string, 0, len(unread))
	for _, report := range unread {
		names = append(names, fmt.Sprintf("%s (turn %d)", report.ID, report.Turn))
	}
	return "\n\nFinished with unread reports: " + strings.Join(names, ", ") + ". Call wait to read them."
}

func (s *mcpServer) callTool(ctx context.Context, params map[string]any) (any, error) {
	name, _ := params["name"].(string)
	index := slices.IndexFunc(s.tools, func(tool mcpTool) bool { return tool.name == name })
	if index < 0 {
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("unknown tool %v", params["name"])}}, "isError": true}, nil
	}
	tool := s.tools[index]
	args, _ := params["arguments"].(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	result, err := tool.call(ctx, args)
	if err != nil {
		var input *toolInputError
		if errors.As(err, &input) {
			return map[string]any{"content": []any{map[string]any{"type": "text", "text": input.message}}, "isError": true}, nil
		}
		return nil, err
	}
	refused := false
	if record, ok := result.(map[string]any); ok && (record["kind"] == "refused" || record["kind"] == oar.ResponseRejected || record["kind"] == "rejected") {
		refused = true
	}
	if sent, ok := result.(agents.SendResult); ok && (sent.Kind == "refused" || sent.Kind == "rejected") {
		refused = true
	}
	note := ""
	if tool.name != "wait" && tool.name != "run" && tool.name != "list" {
		note = s.unreadNote()
	}
	answer := map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.TrimSuffix(pretty(result), "\n") + note}}}
	if tool.outputSchema != nil {
		answer["structuredContent"] = result
	}
	if refused {
		answer["isError"] = true
	}
	return answer, nil
}

type rpcRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params map[string]any  `json:"params"`
}

func (s *mcpServer) answer(ctx context.Context, request rpcRequest) (any, error) {
	params := request.Params
	if params == nil {
		params = map[string]any{}
	}
	switch request.Method {
	case "initialize":
		asked, _ := params["protocolVersion"].(string)
		chosen := protocolVersions[0]
		if slices.Contains(protocolVersions, asked) {
			chosen = asked
		}
		return map[string]any{"protocolVersion": chosen, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "oar", "version": version}, "instructions": instructions}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		tools := make([]map[string]any, 0, len(s.tools))
		for _, tool := range s.tools {
			entry := map[string]any{"name": tool.name, "description": tool.description, "inputSchema": tool.inputSchema}
			if tool.outputSchema != nil {
				entry["outputSchema"] = tool.outputSchema
			}
			tools = append(tools, entry)
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		return s.callTool(ctx, params)
	}
	return nil, errMethodNotFound{request.Method}
}

type errMethodNotFound struct{ method string }

func (e errMethodNotFound) Error() string { return "method not found: " + e.method }

// serve answers until the input ends, then cancels pending calls and closes every subagent.
func (s *mcpServer) serve(ctx context.Context, in io.Reader) {
	var callsMu sync.Mutex
	calls := map[string]context.CancelFunc{}
	var wg sync.WaitGroup
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		var request rpcRequest
		if json.Unmarshal(scanner.Bytes(), &request) != nil {
			continue
		}
		if request.Method == "notifications/cancelled" {
			if id, ok := request.Params["requestId"]; ok {
				callsMu.Lock()
				if cancel := calls[fmt.Sprint(id)]; cancel != nil {
					cancel()
				}
				callsMu.Unlock()
			}
			continue
		}
		if len(request.ID) == 0 || string(request.ID) == "null" {
			continue
		}
		var key any
		_ = json.Unmarshal(request.ID, &key)
		callCtx, cancel := context.WithCancel(ctx)
		callsMu.Lock()
		calls[fmt.Sprint(key)] = cancel
		callsMu.Unlock()
		// Calls run concurrently: a long run must not hold a list behind it.
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				callsMu.Lock()
				delete(calls, fmt.Sprint(key))
				callsMu.Unlock()
				cancel()
			}()
			result, err := s.answer(callCtx, request)
			if err != nil {
				code := -32603
				var notFound errMethodNotFound
				if errors.As(err, &notFound) {
					code = -32601
				}
				s.write(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": code, "message": err.Error()}})
				return
			}
			if callCtx.Err() == nil {
				s.write(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
			}
		}()
	}
	callsMu.Lock()
	for _, cancel := range calls {
		cancel()
	}
	callsMu.Unlock()
	wg.Wait()
}

func (c *cli) mcp(ctx context.Context, raw []string) error {
	parsed, err := parseArgs(raw, []string{"runtimes", "max-running", "max-depth", "cwd", "log-dir"}, nil)
	if err != nil {
		return err
	}
	maxRunning, hasRunning, err := parsed.nonnegative("max-running")
	if err != nil {
		return err
	}
	maxDepth, hasDepth, err := parsed.nonnegative("max-depth")
	if err != nil {
		return err
	}
	var allowed []string
	if list, ok := parsed.value("runtimes"); ok {
		for _, id := range strings.Split(list, ",") {
			if id = strings.TrimSpace(id); id != "" {
				allowed = append(allowed, id)
			}
		}
	}
	var offered []oar.Runtime
	for _, runtime := range c.registry.List() {
		if allowed == nil || slices.Contains(allowed, runtime.ID) {
			offered = append(offered, runtime)
		}
	}
	registry, err := oar.NewRuntimeRegistry(offered...)
	if err != nil {
		return err
	}
	options := agents.Options{Runtimes: registry}
	if hasRunning {
		options.MaxRunning = maxRunning
	}
	if hasDepth {
		options.MaxDepth = maxDepth
	}
	if cwd, ok := parsed.value("cwd"); ok {
		options.Cwd, _ = filepath.Abs(cwd)
	}
	if dir, ok := parsed.value("log-dir"); ok {
		options.LogDir, _ = filepath.Abs(dir)
	}
	crew := agents.New(options)
	server := &mcpServer{tools: subagentTools(crew, offered), crew: crew, out: c.stdout}
	serveCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		server.serve(serveCtx, c.stdin)
		close(done)
	}()
	select {
	case <-done:
	case <-serveCtx.Done():
	}
	// Children run in their own process groups; a stopped server takes them down first.
	closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return crew.Close(closeCtx)
}
