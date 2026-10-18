package tool

import (
	"context"
	"errors"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Schedules that come due: the manager sets, lists and cancels them.

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
				made, err := s.schedule.Add(req, protocol.ScheduleByManager, c.Owner)
				if err != nil {
					return "", err
				}
				if made.Pending {
					return "定好了，等主人同意才生效：\n" + scheduleLine(made, channel.Name) +
						"\n这一轮不是主人叫你定的，而它会反复来或直接派帮工：主人在定时列表里点「同意」才开始。跟主人说一声它是做什么的。", nil
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
