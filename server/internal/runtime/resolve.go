package runtime

import (
	"context"
	"fmt"
	"slices"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/smith/oar"
)

// Resolved is what smith needs after profile overrides and runtime defaults have been reconciled.
type Resolved struct {
	Runtime             oar.Runtime
	Installation        *oar.AvailableInstallation
	InstallationOptions oar.InstallationOptions
	Model               string
	Effort              string
	Env                 map[string]*string
}

func (r *Service) Resolve(ctx context.Context, agent protocol.Agent) (Resolved, error) {
	adapter, ok := r.Runtime(agent.Runtime)
	if !ok {
		return Resolved{}, fmt.Errorf("oar 驱动不了 %s", agent.Runtime)
	}
	info := r.Info(ctx, agent.Runtime)
	settings := r.store.Settings(agent.Runtime)
	wanted := agent.Model
	if wanted == "" {
		wanted = settings.DefaultModel
	}
	known := wanted == "" || info == nil || info.Models == nil || slices.ContainsFunc(info.Models, func(m protocol.ModelEntry) bool { return m.ID == wanted })
	model := wanted
	if !known {
		model = ""
		r.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 没有 %s 这个模型，%s 先用默认模型", protocol.RuntimeLabel(agent.Runtime), wanted, agent.Name))
	}
	effort := agent.Effort
	if effort == "" {
		effort = settings.DefaultEffort
	}
	env := map[string]*string{}
	for _, vars := range []map[string]string{settings.Env, agent.Env} {
		for k, v := range vars {
			env[k] = &v
		}
	}
	r.mu.Lock()
	observed := r.cache[agent.Runtime]
	var installation *oar.AvailableInstallation
	if observed.Info.Settings.BinPath == settings.BinPath && observed.Found != nil {
		copy := *observed.Found
		copy.Shadowed = slices.Clone(copy.Shadowed)
		installation = &copy
	}
	r.mu.Unlock()
	return Resolved{Runtime: adapter, Model: model, Effort: effort, Env: env, Installation: installation, InstallationOptions: oar.InstallationOptions{Binary: &settings.BinPath}}, nil
}
