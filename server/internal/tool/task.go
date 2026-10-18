package tool

import (
	"context"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Splitting: tasks that split a long piece of work into steps.

type graphSplitArgs struct {
	Goal    string `json:"goal" jsonschema:"要做的事，照主人的原话"`
	Project string `json:"project" jsonschema:"项目文件夹名"`
	Agent   string `json:"agent,omitempty" jsonschema:"让谁来拆：帮工名字或 id；不填按规则挑"`
}

func (s *Service) graphSplit() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[graphSplitArgs]{
		Name: "graph_split", Label: labels["graph_split"],
		Description: "起一个种植计划：派一个帮工读代码，把一件很长的活拆成几件，有先后（每件一个帮工），拆好了等主人看过再开工。goal 是主人要做的事，照他的原话写全；project 是项目文件夹名。",
		Parameters:  schemaOf[graphSplitArgs](),
		Run: func(_ context.Context, p graphSplitArgs, _ brain.ToolContext) (string, error) {
			return answered(s.tasks.Split(p.Goal, p.Project, p.Agent, protocol.GraphActorManager))
		},
	})
}

type graphsArgs struct {
	ID string `json:"id,omitempty" jsonschema:"计划 id，比如 p1；不填列出所有没收完的"`
}

func (s *Service) graphsTool() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[graphsArgs]{
		Name: "graphs", Label: labels["graphs"], Description: "列出种植计划：每件的状态、谁在做、结论。",
		Parameters: schemaOf[graphsArgs](),
		Run: func(_ context.Context, p graphsArgs, _ brain.ToolContext) (string, error) {
			var texts []string
			for _, g := range protocol.GraphsOf(s.core.State()) {
				if (p.ID != "" && g.ID == p.ID) || (p.ID == "" && protocol.IsOpen(g)) {
					texts = append(texts, protocol.GraphText(g))
				}
			}
			switch {
			case len(texts) > 0:
				return strings.Join(texts, "\n\n"), nil
			case p.ID != "":
				return "没有 " + p.ID + " 这个计划", nil
			default:
				return "现在没有种植计划。", nil
			}
		},
	})
}

type taskEditArgs struct {
	Graph  string   `json:"graph" jsonschema:"计划 id"`
	Task   string   `json:"task" jsonschema:"这件的 id（新加的就起一个简短的英文 id）"`
	Title  *string  `json:"title,omitempty"`
	Brief  *string  `json:"brief,omitempty" jsonschema:"工单"`
	Needs  []string `json:"needs,omitempty" jsonschema:"要等哪几件做完"`
	Agent  *string  `json:"agent,omitempty" jsonschema:"帮工档案 id；空字符串表示按规则挑"`
	Check  *string  `json:"check,omitempty" jsonschema:"做完跑的检查命令；空字符串表示不跑"`
	Remove bool     `json:"remove,omitempty"`
}

func (s *Service) taskEdit() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[taskEditArgs]{
		Name: "task_edit", Label: labels["task_edit"],
		Description: "改计划里的一件：工单、标题、要等的、谁来做、做完跑的检查命令；没有这一件就加上。remove 为 true 时删掉它。没开工的计划什么都能改；开工以后只能改还没开始或没做成的。",
		Parameters:  schemaOf[taskEditArgs](),
		Run: func(_ context.Context, p taskEditArgs, _ brain.ToolContext) (string, error) {
			if p.Remove {
				return answered(s.tasks.RemoveTask(p.Graph, p.Task, protocol.GraphActorManager))
			}
			edit := protocol.TaskEdit{Title: p.Title, Brief: p.Brief, Needs: p.Needs, Agent: p.Agent, Check: p.Check}
			return answered(s.tasks.EditTask(p.Graph, p.Task, edit, protocol.GraphActorManager))
		},
	})
}

type graphActArgs struct {
	Graph  string               `json:"graph" jsonschema:"计划 id"`
	Action protocol.GraphAction `json:"action"`
}

func (s *Service) graphAction(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[graphActArgs]{
		Name: "graph_action", Label: labels["graph_action"],
		Description: "对整个计划：start 开工（主人看过、同意了才用），pause 暂停（正在做的做完，不开新的），resume 继续，abandon 放弃（分支留着），merge 收获（都做完以后，把计划分支合进主分支）。",
		Parameters:  schemaOf[graphActArgs](),
		Run: func(ctx context.Context, p graphActArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			if p.Action == protocol.GraphActionMerge && !c.Owner {
				return mergeNotAsked, nil
			}
			if p.Action == protocol.GraphActionStart && !c.Owner {
				return startNotAsked, nil
			}
			return answered(s.tasks.Act(p.Graph, p.Action, protocol.GraphActorManager))
		},
	})
}

type taskActArgs struct {
	Graph  string              `json:"graph" jsonschema:"计划 id"`
	Task   string              `json:"task" jsonschema:"这件的 id"`
	Action protocol.TaskAction `json:"action"`
}

func (s *Service) taskAction() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[taskActArgs]{
		Name: "task_action", Label: labels["task_action"], Description: "对计划里的一件：retry 重试没做成的，skip 跳过它（后面的照常开工）。",
		Parameters: schemaOf[taskActArgs](),
		Run: func(_ context.Context, p taskActArgs, _ brain.ToolContext) (string, error) {
			return answered(s.tasks.TaskAct(p.Graph, p.Task, p.Action, protocol.GraphActorManager))
		},
	})
}
