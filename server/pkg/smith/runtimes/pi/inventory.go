package pi

import (
	"context"
	"encoding/json"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// inventory reads one of pi's native inventories through the host
// (inventory.ts): an in-memory session of pi's SDK in the scope's cwd, with
// no trust-store write and no model prompt.
func inventory[T any](what string) oar.InventoryReader[T] {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.InventoryOptions) (oar.InventoryResult[T], error) {
		installation, err := executableOf(ctx, installation)
		if err != nil {
			return shared.UnsupportedInventory[T]("installation_unsupported", "Pi inventory requires the pi SDK of an installed pi"), nil
		}
		scope := shared.WorkspaceScope(options)
		return shared.InventoryRead(ctx, options.Timeout, func(ctx context.Context) (oar.InventoryResult[T], error) {
			data, err := hostJob(ctx, installation, scope.Cwd, 0, jsonx.Record{"type": "inventory", "what": what, "cwd": scope.Cwd, "agentDir": AgentDir()})
			if err != nil {
				return oar.InventoryResult[T]{}, err
			}
			var answer struct {
				View    string `json:"view"`
				Partial bool   `json:"partial"`
				Items   []T    `json:"items"`
			}
			if err := json.Unmarshal(data, &answer); err != nil {
				return oar.InventoryResult[T]{}, err
			}
			return shared.InventoryOk(scope, answer.View, answer.Items, answer.Partial), nil
		})
	}
}

// Skills, Commands and Tools are pi's native inventories.
var (
	Skills   = inventory[oar.SkillEntry]("skills")
	Commands = inventory[oar.CommandEntry]("commands")
	Tools    = inventory[oar.ToolEntry]("tools")
)
