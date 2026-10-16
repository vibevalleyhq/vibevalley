package grok

import (
	"context"
	"errors"
	"strings"
	"sync"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// ProjectSkills projects `grok inspect --json`'s skills.
func ProjectSkills(payload jsonx.Record) ([]oar.SkillEntry, error) {
	rows, err := shared.NativeRows(payload["skills"])
	if err != nil {
		return nil, err
	}
	out := make([]oar.SkillEntry, 0, len(rows))
	for _, skill := range rows {
		name, err := shared.Named(skill)
		if err != nil {
			return nil, err
		}
		out = append(out, oar.SkillEntry{Name: name, Description: shared.TextField(skill["description"]), Source: shared.TextField(skill["source"])})
	}
	return out, nil
}

// ProjectServers projects `grok inspect --json`'s MCP servers, credential-free.
func ProjectServers(payload jsonx.Record) ([]oar.McpServerEntry, error) {
	rows, err := shared.NativeRows(payload["mcpServers"])
	if err != nil {
		return nil, err
	}
	out := make([]oar.McpServerEntry, 0, len(rows))
	for _, server := range rows {
		name, err := shared.Named(server)
		if err != nil {
			return nil, err
		}
		out = append(out, oar.McpServerEntry{ID: name, Name: name, Source: shared.TextField(server["source"])})
	}
	return out, nil
}

// inspect waits for `grok inspect --json` to end and parses its stdout.
func inspect(ctx context.Context, child *executable.LineProcess, stdout func() string) (jsonx.Record, error) {
	select {
	case <-child.Exited():
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if code := child.ExitCode(); code == nil || *code != 0 {
		return nil, errors.New("Grok inspect failed")
	}
	payload := jsonx.ParseRecord([]byte(stdout()))
	if payload == nil {
		return nil, errors.New("Invalid Grok inspect result")
	}
	return payload, nil
}

// reader: inspect is cwd-scoped discovery including compatibility entries,
// not live connections. The owned process is killed, and its exit awaited,
// before the reader answers, a timeout included.
func reader[T any](project func(jsonx.Record) ([]T, error)) oar.InventoryReader[T] {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.InventoryOptions) (oar.InventoryResult[T], error) {
		if !installation.IsExecutable() {
			return shared.UnsupportedInventory[T]("installation_unsupported", "Grok inventory requires an executable"), nil
		}
		scope := shared.WorkspaceScope(options)
		child, spawnErr := executable.Spawn(installation.Command, []string{"inspect", "--json"}, executable.LineOptions{Dir: scope.Cwd, KillTree: true})
		var mu sync.Mutex
		var lines []string
		if spawnErr == nil {
			child.OnLine(func(line string) {
				mu.Lock()
				lines = append(lines, line)
				mu.Unlock()
			})
			defer func() {
				child.Kill()
				<-child.Exited()
			}()
		}
		stdout := func() string {
			mu.Lock()
			defer mu.Unlock()
			return strings.Join(lines, "\n")
		}
		return shared.InventoryRead(ctx, options.Timeout, func(ctx context.Context) (oar.InventoryResult[T], error) {
			if spawnErr != nil {
				return oar.InventoryResult[T]{}, spawnErr
			}
			payload, err := inspect(ctx, child, stdout)
			if err != nil {
				return oar.InventoryResult[T]{}, err
			}
			items, err := project(payload)
			if err != nil {
				return oar.InventoryResult[T]{}, err
			}
			return shared.InventoryOk(scope, "discovered", items, false), nil
		})
	}
}

// Skills is grok's skill inventory.
var Skills = reader(ProjectSkills)

// MCPServers is grok's MCP server inventory.
var MCPServers = reader(ProjectServers)
