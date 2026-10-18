package tool

import (
	"context"
	"errors"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Splitting: tasks that split a long piece of work into steps, and schedules that come due.

type scheduleArgs struct {
	Name    string       `json:"name" jsonschema:"简短的名字，比如 每日测试"`
	Text    string       `json:"text" jsonschema:"到点时说的话：要做的事"`
	Kind    scheduleKind `json:"kind"`
	At      string       `json:"at,omitempty"`
	Minutes *float64     `json:"minutes,omitempty"`
	Time    string       `json:"time,omitempty" jsonschema:"HH:MM"`
	Days    []float64    `json:"days,omitempty"`
	Cron    string       `json:"cron,omitempty" jsonschema:"五段 cron：分 时 日 月 周几"`
	Channel string       `json:"channel,omitempty" jsonschema:"在哪个频道，比如 #clock-in；不填是你正在回话的频道"`
	Agent   string       `json:"agent,omitempty" jsonschema:"直接派给哪个帮工档案（名字或 id）；不填就是到点交给你"`
	Project string       `json:"project,omitempty" jsonschema:"直接派活时的项目；不填用频道的默认项目"`
	TZ      string       `json:"tz,omitempty" jsonschema:"时区，比如 Asia/Shanghai；不填是这台电脑的"`
}

func (s *Service) scheduleTool(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[scheduleArgs]{
		Name: "schedule", Label: labels["schedule"],
		Description: "定一件按时间来的事：到点时频道里出现一条「⏰ 定时」消息，然后你收到它照着做；填了 agent 就直接派那个帮工去做（工单就是 text），不经过你。kind：once（at 填 ISO 时间，带时区，比如 2026-10-13T09:00:00+08:00）、every（minutes 每隔几分钟，至少 1）、daily（time 填 HH:MM）、weekly（days 填周几，0 是周日，加 time）、cron（cron 填五段：分 时 日 月 周几，比如工作日 9 点是 0 9 * * 1-5，每月 1 号 10 点是 0 10 1 * *；前四种说不清的才用它）。text 写清楚到时候做什么、做完告诉谁。",
		Parameters:  schemaOf[scheduleArgs](),
		Run: func(ctx context.Context, p scheduleArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			return answered(func() (string, error) {
				channel := s.chat.ChannelOf(c.Here)
				if p.Channel != "" {
					named := s.chat.ChannelByName(p.Channel)
					if named == nil {
						return "", errors.New("没有 " + p.Channel + " 这个频道：先用 channels 看看")
					}
					channel = *named
				}
				var when protocol.ScheduleWhenValue
				switch p.Kind {
				case "once":
					at, ok := parseTime(p.At)
					if !ok {
						shown := p.At
						if shown == "" {
							shown = "（没填）"
						}
						return "", errors.New("at 不是一个时间：" + shown)
					}
					when = protocol.ScheduleWhenOnce{At: at}
				case "every":
					minutes := 0.0
					if p.Minutes != nil {
						minutes = *p.Minutes
					}
					when = protocol.ScheduleWhenEvery{Minutes: minutes}
				case "daily":
					when = protocol.ScheduleWhenDaily{Time: p.Time}
				case "cron":
					when = protocol.ScheduleWhenCron{Expr: p.Cron}
				default:
					days := []int64{}
					for _, d := range p.Days {
						days = append(days, int64(d))
					}
					when = protocol.ScheduleWhenWeekly{Days: days, Time: p.Time}
				}
				id := channel.ID
				req := protocol.ScheduleRequest{Name: p.Name, Text: p.Text, Channel: &id, When: protocol.ScheduleWhen{Value: when}}
				if p.Agent != "" {
					req.Agent = &p.Agent
				}
				if p.Project != "" {
					req.Project = &p.Project
				}
				if p.TZ != "" {
					req.TZ = &p.TZ
				}
				made, err := s.schedule.Add(req)
				if err != nil {
					return "", err
				}
				return "定好了：\n" + scheduleLine(made, channel.Name), nil
			}())
		},
	})
}

func (s *Service) listSchedules() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[none]{
		Name: "list_schedules", Label: labels["list_schedules"], Description: "列出定时：编号、在哪个频道、什么时候、下次什么时候、到点做什么。",
		Parameters: schemaOf[none](),
		Run: func(context.Context, none, brain.ToolContext) (string, error) {
			all := s.schedule.List()
			if len(all) == 0 {
				return "没有定时。", nil
			}
			names := map[string]string{}
			for _, c := range s.chat.Channels() {
				names[c.ID] = c.Name
			}
			lines := make([]string, len(all))
			for i, s := range all {
				name, ok := names[s.Channel]
				if !ok {
					name = "?"
				}
				lines[i] = scheduleLine(s, name)
			}
			return strings.Join(lines, "\n"), nil
		},
	})
}

type idArgs struct {
	ID string `json:"id"`
}

func (s *Service) cancelSchedule() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[idArgs]{
		Name: "cancel_schedule", Label: labels["cancel_schedule"], Description: "删掉一个定时（编号从 list_schedules 看）。",
		Parameters: schemaOf[idArgs](),
		Run: func(_ context.Context, p idArgs, _ brain.ToolContext) (string, error) {
			s, err := s.schedule.Remove(p.ID)
			return answered("删掉了「"+s.Name+"」。", err)
		},
	})
}

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
