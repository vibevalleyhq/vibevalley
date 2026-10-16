package claude

import (
	"context"
	"errors"
	"regexp"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// claude's inventory (inventory.ts): native control queries on a stream-json
// process, projected into credential-free entries.

func projectClaudeSkills(payload jsonx.Record) ([]oar.SkillEntry, error) {
	rows, err := shared.NativeRows(jsonx.AsRecord(payload["skills"])["skillFrontmatter"])
	if err != nil {
		return nil, err
	}
	entries := make([]oar.SkillEntry, 0, len(rows))
	for _, skill := range rows {
		name, err := shared.Named(skill)
		if err != nil {
			return nil, err
		}
		entries = append(entries, oar.SkillEntry{Name: name, Source: shared.TextField(skill["source"])})
	}
	return entries, nil
}

func projectClaudeCommands(payload jsonx.Record) ([]oar.CommandEntry, error) {
	rows, err := shared.NativeRows(payload["commands"])
	if err != nil {
		return nil, err
	}
	entries := make([]oar.CommandEntry, 0, len(rows))
	for _, command := range rows {
		var aliases []string
		if raw, present := command["aliases"]; present {
			list, ok := raw.([]any)
			if !ok {
				return nil, errors.New("Native command aliases are not strings")
			}
			aliases = []string{}
			for _, alias := range list {
				text, ok := alias.(string)
				if !ok {
					return nil, errors.New("Native command aliases are not strings")
				}
				aliases = append(aliases, text)
			}
		}
		name, err := shared.Named(command)
		if err != nil {
			return nil, err
		}
		entry := oar.CommandEntry{Name: name, Description: shared.TextField(command["description"]), Aliases: aliases}
		// claude gives "" for a command without a hint; absent reads the same as pi (#351).
		entry.ArgumentHint = shared.TextField(command["argumentHint"])
		if command["builtin"] == true {
			entry.Source = "builtin"
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func projectClaudeServers(servers []jsonx.Record) ([]oar.McpServerEntry, error) {
	entries := make([]oar.McpServerEntry, 0, len(servers))
	for _, server := range servers {
		name, err := shared.Named(server)
		if err != nil {
			return nil, err
		}
		entry := oar.McpServerEntry{ID: name, Name: name, Status: shared.TextField(server["status"]), Source: shared.TextField(server["scope"])}
		if tools, ok := server["tools"].([]any); ok {
			count := len(tools)
			entry.ToolCount = &count
		}
		if value, present := server["error"]; present && value != nil {
			entry.Error = "Native MCP connection failed"
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func projectClaudeTools(servers []jsonx.Record) ([]oar.ToolEntry, error) {
	entries := []oar.ToolEntry{}
	for _, server := range servers {
		if _, present := server["tools"]; !present {
			continue
		}
		serverName, err := shared.Named(server)
		if err != nil {
			return nil, err
		}
		rows, err := shared.NativeRows(server["tools"])
		if err != nil {
			return nil, err
		}
		for _, tool := range rows {
			name, err := shared.Named(tool)
			if err != nil {
				return nil, err
			}
			entries = append(entries, oar.ToolEntry{Name: name, McpServerID: serverName, Source: "mcp", Description: shared.TextField(tool["description"])})
		}
	}
	return entries, nil
}

var errUnsupportedControl = errors.New("UnsupportedControlError")

var unsupportedControl = regexp.MustCompile(`(?i)unsupported|not supported|unknown control`)

type inventoryPending struct {
	id    string
	reply chan inventoryReply
}

type inventoryReply struct {
	value jsonx.Record
	err   error
}

func inventoryReader[T any](read func(ctx context.Context, request shared.NativeInventoryRequest, scope oar.InventoryScope, initialized jsonx.Record) (oar.InventoryResult[T], error)) oar.InventoryReader[T] {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.InventoryOptions) (oar.InventoryResult[T], error) {
		if installation.Via != "executable" {
			return shared.UnsupportedInventory[T]("installation_unsupported", "Claude inventory requires an executable"), nil
		}
		scope := shared.WorkspaceScope(options)
		child, err := spawnLineProcess(installation.Command, []string{
			"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
		}, executable.LineOptions{Dir: scope.Cwd, Env: claudeEnv(), KillTree: true})
		if err != nil {
			return shared.UnavailableInventory[T]("query_failed", "Native inventory query failed"), nil
		}
		var mu sync.Mutex
		var pending *inventoryPending
		closed := false
		settle := func(target *inventoryPending, reply inventoryReply) {
			select {
			case target.reply <- reply:
			default:
			}
		}
		child.OnLine(func(line string) {
			message := jsonx.ParseRecord([]byte(line))
			response := jsonx.AsRecord(message["response"])
			mu.Lock()
			defer mu.Unlock()
			if message["type"] != "control_response" || response == nil || pending == nil || response["request_id"] != pending.id {
				return
			}
			waiter := pending
			pending = nil
			if response["subtype"] == "success" {
				value := jsonx.AsRecord(response["response"])
				if value == nil {
					value = jsonx.Record{}
				}
				settle(waiter, inventoryReply{value: value})
			} else if text, ok := response["error"].(string); ok && unsupportedControl.MatchString(text) {
				settle(waiter, inventoryReply{err: errUnsupportedControl})
			} else {
				settle(waiter, inventoryReply{err: errors.New("Native control query failed")})
			}
		})
		child.OnExit(func(*int) {
			mu.Lock()
			defer mu.Unlock()
			closed = true
			if pending != nil {
				settle(pending, inventoryReply{err: errors.New("Native process exited")})
				pending = nil
			}
		})
		request := func(ctx context.Context, method string, params jsonx.Record) (jsonx.Record, error) {
			mu.Lock()
			if closed {
				mu.Unlock()
				return nil, errors.New("Native process exited")
			}
			waiter := &inventoryPending{id: observe.NewUUID(), reply: make(chan inventoryReply, 1)}
			pending = waiter
			body := map[string]any{"subtype": method}
			for key, value := range params {
				body[key] = value
			}
			child.Write(jsonText(controlRequest{Type: "control_request", RequestID: waiter.id, Request: body}) + "\n")
			mu.Unlock()
			select {
			case reply := <-waiter.reply:
				return reply.value, reply.err
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		defer func() {
			child.Kill()
			<-child.Exited()
		}()
		return shared.InventoryRead(ctx, options.Timeout, func(ctx context.Context) (oar.InventoryResult[T], error) {
			// The owned process is killed once, after InventoryRead answers
			// (the deferred Kill above); a pending request ends with ctx.
			initialized, err := request(ctx, "initialize", jsonx.Record{})
			if err == nil {
				var result oar.InventoryResult[T]
				result, err = read(ctx, request, scope, initialized)
				if err == nil {
					return result, nil
				}
			}
			if errors.Is(err, errUnsupportedControl) {
				return shared.UnsupportedInventory[T]("native_query_unavailable", "This Claude build does not expose the inventory query"), nil
			}
			return oar.InventoryResult[T]{}, err
		})
	}
}

// readServers waits, bounded, for servers still starting; pending is returned as partial rather than hidden.
func readServers(ctx context.Context, request shared.NativeInventoryRequest) ([]jsonx.Record, error) {
	payload, err := request(ctx, "mcp_status", jsonx.Record{})
	if err != nil {
		return nil, err
	}
	servers, err := shared.NativeRows(payload["mcpServers"])
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 10 && anyPending(servers); attempt++ {
		select {
		case <-time.After(200 * time.Millisecond):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		if payload, err = request(ctx, "mcp_status", jsonx.Record{}); err != nil {
			return nil, err
		}
		if servers, err = shared.NativeRows(payload["mcpServers"]); err != nil {
			return nil, err
		}
	}
	return servers, nil
}

func anyPending(servers []jsonx.Record) bool {
	for _, server := range servers {
		if server["status"] == "pending" {
			return true
		}
	}
	return false
}

func partialServers(servers []jsonx.Record) bool {
	for _, server := range servers {
		if server["status"] == "pending" || server["status"] == "failed" {
			return true
		}
	}
	return false
}

// Skills is claude's skill inventory (claudeSkills).
var Skills = inventoryReader(func(ctx context.Context, request shared.NativeInventoryRequest, scope oar.InventoryScope, _ jsonx.Record) (oar.InventoryResult[oar.SkillEntry], error) {
	payload, err := request(ctx, "get_context_usage", jsonx.Record{"detail": "summary"})
	if err != nil {
		return oar.InventoryResult[oar.SkillEntry]{}, err
	}
	skills, err := projectClaudeSkills(payload)
	if err != nil {
		return oar.InventoryResult[oar.SkillEntry]{}, err
	}
	return shared.InventoryOk(scope, "context", skills, false), nil
})

// Commands is claude's command inventory (claudeCommands).
var Commands = inventoryReader(func(_ context.Context, _ shared.NativeInventoryRequest, scope oar.InventoryScope, initialized jsonx.Record) (oar.InventoryResult[oar.CommandEntry], error) {
	commands, err := projectClaudeCommands(initialized)
	if err != nil {
		return oar.InventoryResult[oar.CommandEntry]{}, err
	}
	return shared.InventoryOk(scope, "discovered", commands, false), nil
})

// MCPServers is claude's MCP server inventory (claudeMcpServers).
var MCPServers = inventoryReader(func(ctx context.Context, request shared.NativeInventoryRequest, scope oar.InventoryScope, _ jsonx.Record) (oar.InventoryResult[oar.McpServerEntry], error) {
	servers, err := readServers(ctx, request)
	if err != nil {
		return oar.InventoryResult[oar.McpServerEntry]{}, err
	}
	entries, err := projectClaudeServers(servers)
	if err != nil {
		return oar.InventoryResult[oar.McpServerEntry]{}, err
	}
	return shared.InventoryOk(scope, "discovered", entries, partialServers(servers)), nil
})

// Tools is claude's MCP tool inventory (claudeTools).
var Tools = inventoryReader(func(ctx context.Context, request shared.NativeInventoryRequest, scope oar.InventoryScope, _ jsonx.Record) (oar.InventoryResult[oar.ToolEntry], error) {
	servers, err := readServers(ctx, request)
	if err != nil {
		return oar.InventoryResult[oar.ToolEntry]{}, err
	}
	entries, err := projectClaudeTools(servers)
	if err != nil {
		return oar.InventoryResult[oar.ToolEntry]{}, err
	}
	return shared.InventoryOk(scope, "mcp-only", entries, partialServers(servers)), nil
})
