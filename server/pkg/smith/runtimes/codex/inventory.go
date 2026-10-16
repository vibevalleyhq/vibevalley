package codex

import (
	"context"
	"encoding/json"
	"errors"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// codex's inventory (inventory.ts): app-server queries projected into
// credential-free entries.

// inventoryRequest is one app-server request of an inventory read.
type inventoryRequest func(ctx context.Context, method string, params jsonx.Record) (rpcResult, error)

func projectCodexSkills(payload jsonx.Record) ([]oar.SkillEntry, error) {
	entries, err := shared.NativeRows(payload["data"])
	if err != nil {
		return nil, err
	}
	skills := []oar.SkillEntry{}
	for _, entry := range entries {
		rows, err := shared.NativeRows(entry["skills"])
		if err != nil {
			return nil, err
		}
		for _, skill := range rows {
			name, err := shared.Named(skill)
			if err != nil {
				return nil, err
			}
			skills = append(skills, oar.SkillEntry{
				Name:        name,
				Description: shared.TextField(skill["description"]),
				Path:        shared.TextField(skill["path"]),
				Source:      shared.TextField(skill["scope"]),
				Enabled:     shared.BoolField(skill["enabled"]),
			})
		}
	}
	return skills, nil
}

// codexServer is an `mcpServerStatus/list` entry, decoded and raw.
type codexServer struct {
	record jsonx.Record
	raw    json.RawMessage
}

func hasToolsError(server codexServer) bool {
	value, present := server.record["toolsError"]
	return present && value != nil
}

func projectCodexServers(servers []codexServer) ([]oar.McpServerEntry, error) {
	entries := []oar.McpServerEntry{}
	for _, server := range servers {
		name, err := shared.Named(server.record)
		if err != nil {
			return nil, err
		}
		entry := oar.McpServerEntry{ID: name, Name: name, Status: shared.TextField(server.record["runtimeStatus"]), AuthStatus: shared.TextField(server.record["authStatus"])}
		if tools := jsonx.AsRecord(server.record["tools"]); tools != nil {
			count := len(tools)
			entry.ToolCount = &count
		}
		if hasToolsError(server) {
			entry.Error = "Native tool discovery failed"
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func projectCodexTools(servers []codexServer) ([]oar.ToolEntry, error) {
	entries := []oar.ToolEntry{}
	for _, server := range servers {
		tools := jsonx.AsRecord(server.record["tools"])
		if tools == nil {
			continue
		}
		serverName, err := shared.Named(server.record)
		if err != nil {
			return nil, err
		}
		rawTools := jsonx.RawFields(jsonx.RawFields(server.raw)["tools"])
		for _, key := range objectKeys(jsonx.RawFields(server.raw)["tools"]) {
			tool := jsonx.AsRecord(tools[key])
			if tool == nil {
				tool = jsonx.Record{}
			}
			name, err := shared.Named(tool)
			if err != nil {
				return nil, err
			}
			entry := oar.ToolEntry{Name: name, McpServerID: serverName, Source: "mcp", Description: shared.TextField(tool["description"])}
			if jsonx.AsRecord(tool["inputSchema"]) != nil {
				entry.InputSchema = compactRaw(jsonx.RawFields(rawTools[key])["inputSchema"])
			}
			entries = append(entries, entry)
		}
	}
	return entries, nil
}

const maxMcpPages = 100

func serversOf(ctx context.Context, request inventoryRequest) ([]codexServer, error) {
	servers := []codexServer{}
	seen := map[string]bool{}
	var cursor any
	for len(seen) <= maxMcpPages {
		page, err := request(ctx, "mcpServerStatus/list", jsonx.Record{"detail": "full", "limit": maxMcpPages, "cursor": cursor})
		if err != nil {
			return nil, err
		}
		rows, err := shared.NativeRows(page.record["data"])
		if err != nil {
			return nil, err
		}
		var raws []json.RawMessage
		_ = json.Unmarshal(jsonx.RawFields(page.raw)["data"], &raws)
		for index, row := range rows {
			server := codexServer{record: row}
			if index < len(raws) {
				server.raw = raws[index]
			}
			servers = append(servers, server)
		}
		next, present := page.record["nextCursor"]
		if present && next == nil {
			return servers, nil
		}
		text, ok := next.(string)
		if !ok || seen[text] || len(seen) >= maxMcpPages {
			return nil, errors.New("Invalid MCP pagination")
		}
		cursor = text
		seen[text] = true
	}
	return nil, errors.New("MCP pagination exceeded limit")
}

func readCodexSkills(ctx context.Context, request inventoryRequest, scope oar.InventoryScope, cwd string) (oar.InventoryResult[oar.SkillEntry], error) {
	result, err := request(ctx, "skills/list", jsonx.Record{"cwds": []any{cwd}})
	if err != nil {
		return oar.InventoryResult[oar.SkillEntry]{}, err
	}
	entries, err := shared.NativeRows(result.record["data"])
	if err != nil {
		return oar.InventoryResult[oar.SkillEntry]{}, err
	}
	partial := false
	for _, entry := range entries {
		if errs, ok := entry["errors"].([]any); ok && len(errs) > 0 {
			partial = true
		}
	}
	skills, err := projectCodexSkills(result.record)
	if err != nil {
		return oar.InventoryResult[oar.SkillEntry]{}, err
	}
	return shared.InventoryOk(scope, "discovered", skills, partial), nil
}

var inventoryInitialize = jsonx.Record{"clientInfo": jsonx.Record{"name": "oar-inventory", "version": "0.0.0"}, "capabilities": jsonx.Record{"experimentalApi": true}}

func inventoryReader[T any](read func(ctx context.Context, request inventoryRequest, scope oar.InventoryScope, cwd string) (oar.InventoryResult[T], error)) oar.InventoryReader[T] {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.InventoryOptions) (oar.InventoryResult[T], error) {
		if installation.Via != "executable" {
			return shared.UnsupportedInventory[T]("installation_unsupported", "Codex inventory requires an executable"), nil
		}
		scope := shared.WorkspaceScope(options)
		client := startAppServerClient(installation.Command, nil, nil, scope.Cwd, appServerProcessOptions{})
		_ = client.handle(ignoredFrames)
		defer func() {
			client.kill()
			<-client.exited()
		}()
		return shared.InventoryRead(ctx, options.Timeout, func(ctx context.Context) (oar.InventoryResult[T], error) {
			// The read's ctx ends at its deadline: the process goes with it.
			stop := context.AfterFunc(ctx, client.kill)
			defer stop()
			if err := client.spawned(ctx); err != nil {
				return oar.InventoryResult[T]{}, err
			}
			if _, err := client.request(ctx, "initialize", inventoryInitialize, nil); err != nil {
				return oar.InventoryResult[T]{}, err
			}
			client.notify("initialized", jsonx.Record{})
			return read(ctx, func(ctx context.Context, method string, params jsonx.Record) (rpcResult, error) {
				return client.request(ctx, method, params, nil)
			}, scope, scope.Cwd)
		})
	}
}

// Skills lists codex's skills (codexSkills).
var Skills = inventoryReader(readCodexSkills)

// MCPServers lists codex's MCP servers (codexMcpServers).
var MCPServers = inventoryReader(func(ctx context.Context, request inventoryRequest, scope oar.InventoryScope, _ string) (oar.InventoryResult[oar.McpServerEntry], error) {
	servers, err := serversOf(ctx, request)
	if err != nil {
		return oar.InventoryResult[oar.McpServerEntry]{}, err
	}
	entries, err := projectCodexServers(servers)
	if err != nil {
		return oar.InventoryResult[oar.McpServerEntry]{}, err
	}
	return shared.InventoryOk(scope, "discovered", entries, anyToolsError(servers)), nil
})

// Tools lists the tools of codex's MCP servers (codexTools).
var Tools = inventoryReader(func(ctx context.Context, request inventoryRequest, scope oar.InventoryScope, _ string) (oar.InventoryResult[oar.ToolEntry], error) {
	servers, err := serversOf(ctx, request)
	if err != nil {
		return oar.InventoryResult[oar.ToolEntry]{}, err
	}
	entries, err := projectCodexTools(servers)
	if err != nil {
		return oar.InventoryResult[oar.ToolEntry]{}, err
	}
	return shared.InventoryOk(scope, "mcp-only", entries, anyToolsError(servers)), nil
})

func anyToolsError(servers []codexServer) bool {
	for _, server := range servers {
		if hasToolsError(server) {
			return true
		}
	}
	return false
}
