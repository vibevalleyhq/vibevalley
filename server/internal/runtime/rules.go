package runtime

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

func whenText(at int64) string {
	d := time.UnixMilli(at).In(time.Local)
	return fmt.Sprintf("%d 月 %d 日 %02d:%02d", int(d.Month()), d.Day(), d.Hour(), d.Minute())
}

func moneyStop(info *protocol.RuntimeInfo) string {
	if info == nil {
		return ""
	}
	switch u := info.Usage.Value.(type) {
	case protocol.AccountUsageOk:
		for _, w := range u.Windows {
			if w.UsedPercent < 100 {
				continue
			}
			resets := ""
			if w.ResetsAt != nil && *w.ResetsAt != 0 {
				resets = "，" + whenText(*w.ResetsAt) + "重置"
			}
			return protocol.RuntimeLabel(info.ID) + " 的额度用完了（" + w.Label + "）" + resets + "，到时候再派"
		}
	case protocol.AccountUsageBalance:
		if len(u.Balances) > 0 {
			empty := true
			for _, b := range u.Balances {
				if b.Amount > 0 {
					empty = false
				}
			}
			if !u.Available || empty {
				return u.Provider + " 的余额用完了，充值以后再派"
			}
		}
	}
	budget, spent := 0.0, 0.0
	if info.Settings.DailyBudget != nil {
		budget = *info.Settings.DailyBudget
	}
	if info.SpentToday != nil {
		spent = *info.SpentToday
	}
	if budget > 0 && spent >= budget {
		return "今天已经花了 " + protocol.Yuan(spent) + "，到了每日预算 " + protocol.Yuan(budget) + "（在 Runtime 页面可以改）"
	}
	return ""
}

// Mirrors the checks oar makes when a session opens.
func agentIssues(agent protocol.Agent, runtime *protocol.RuntimeInfo) []protocol.AgentIssue {
	issues := []protocol.AgentIssue{}
	add := func(field string, level protocol.AgentIssueLevel, text string) {
		issues = append(issues, protocol.AgentIssue{Field: field, Level: level, Text: text})
	}
	facts := protocol.FactsOf(agent.Runtime)
	if runtime != nil && runtime.Refused != nil {
		facts.Refused = runtime.Refused
	}
	if runtime == nil {
		add("runtime", "error", "不认识的 runtime："+agent.Runtime)
	} else if _, ok := runtime.Installation.Value.(protocol.InstallationAvailable); !ok {
		add("runtime", "error", "这台机器上找不到这个 runtime")
	} else if !runtime.Settings.Enabled {
		add("runtime", "error", "这个 runtime 在 Runtime 页面里被停用了")
	}
	if broke := moneyStop(runtime); broke != "" {
		add("runtime", "error", broke)
	}

	promptOption := ""
	switch agent.PersonaMode {
	case protocol.PersonaModeAppend:
		promptOption = protocol.SessionAppendSystemPrompt
	case protocol.PersonaModeReplace:
		promptOption = protocol.SessionSystemPrompt
	}
	if str.Trim(agent.Persona) != "" && promptOption != "" && facts.Refused[promptOption] != "" {
		add("persona", "error", facts.Refused[promptOption]+"。把人设改成「写进工单开头」。")
	}
	if agent.Effort != "" && facts.Refused[protocol.SessionEffort] != "" {
		add("effort", "error", facts.Refused[protocol.SessionEffort])
	}
	if len(agent.Env) > 0 && facts.Refused[protocol.SessionEnv] != "" {
		add("env", "error", facts.Refused[protocol.SessionEnv])
	}
	if len(agent.MCPServers) > 0 && facts.Refused[protocol.SessionMCPServers] != "" {
		add("mcpServers", "error", facts.Refused[protocol.SessionMCPServers])
	}
	if len(agent.DisallowedTools) > 0 && facts.Refused[protocol.SessionDisallowedTools] != "" {
		add("disallowedTools", "error", facts.Refused[protocol.SessionDisallowedTools])
	}
	if runtime != nil && runtime.Models != nil && agent.Model != "" {
		var model *protocol.ModelEntry
		for i := range runtime.Models {
			if runtime.Models[i].ID == agent.Model {
				model = &runtime.Models[i]
				break
			}
		}
		if model == nil {
			add("model", "warn", runtime.ID+" 的模型列表里没有 "+agent.Model)
		} else if agent.Effort != "" && len(model.EffortLevels) > 0 && !slices.Contains(model.EffortLevels, agent.Effort) {
			add("effort", "error", model.Name+" 没有 "+agent.Effort+" 这一档，可选："+strings.Join(model.EffortLevels, "、"))
		}
	} else if runtime != nil && runtime.Models != nil && agent.Effort != "" {
		// No model named: the runtime's default one (its settings', else the one it says it uses) must take the effort.
		var model *protocol.ModelEntry
		for i := range runtime.Models {
			if (runtime.Settings.DefaultModel != "" && runtime.Models[i].ID == runtime.Settings.DefaultModel) ||
				(runtime.Settings.DefaultModel == "" && runtime.Models[i].IsDefault) {
				model = &runtime.Models[i]
				break
			}
		}
		if model != nil && len(model.EffortLevels) > 0 && !slices.Contains(model.EffortLevels, agent.Effort) {
			add("effort", "error", runtime.ID+" 默认用的 "+model.Name+" 没有 "+agent.Effort+" 这一档，可选："+strings.Join(model.EffortLevels, "、"))
		}
	}
	return issues
}
