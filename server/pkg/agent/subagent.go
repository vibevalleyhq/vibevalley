package agent

// A helper cannot send helpers.

import (
	"context"
	"errors"
	"strings"

	"vibevalley/pkg/agentcore"
)

func SubagentTool(spawn func(ctx context.Context, task, label string) (string, error)) agentcore.AgentTool {
	type params struct {
		Task  string  `json:"task"`
		Label *string `json:"label"`
	}
	return TextTool(TextToolSpec[params]{
		Name:        "spawn_agent",
		Description: "派一个帮手去做一件独立的事（查资料、读一片代码、改一个模块、跑一组检查），它做完把结果汇报给你。它看不到你们的对话：task 里写清楚要做什么、在哪、做到什么程度算完、汇报什么。几件互不相干的事可以在同一步里派几个，它们会同时做。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"task": agentcore.StringSchema(), "label": agentcore.StringSchema()}, "task"),
		Run: func(ctx context.Context, p params, _ ToolContext) (string, error) {
			if strings.TrimSpace(p.Task) == "" {
				return "", errors.New("task 是空的。")
			}
			label := runeSlice(p.Task, 0, 20)
			if p.Label != nil {
				label = *p.Label
			}
			return spawn(ctx, p.Task, label)
		},
	})
}

func SUBAGENT_INSTRUCTIONS(parent string) string {
	return "你是「" + parent + "」派出去的帮手，只做下面交代的这一件事，做完就停。\n" +
		"- 不能问问题：信息不够就按最合理的理解去做，在汇报里说明你的理解。\n" +
		"- 最后用一段话汇报：做了什么、结果是什么（要点、改过的文件、关键的数字）、没做成的和原因。你的最后一段话就是交回去的全部内容。"
}
