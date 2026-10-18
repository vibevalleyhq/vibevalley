package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"vibevalley/internal/channel"
	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Every tool answers in a sentence, a refusal included: the manager passes it on.

// JS's s.slice(-n), without splitting a character.
func managerTail(s string, n int) string {
	units := 0
	runes := []rune(s)
	for i := len(runes) - 1; i >= 0; i-- {
		units += utf16.RuneLen(runes[i])
		if units > n {
			return string(runes[i+1:])
		}
	}
	return s
}

func managerDescribeChanges(c protocol.Changes) string {
	paths := func(items []protocol.UncommittedItem) string {
		out := make([]string, len(items))
		for i, f := range items {
			out[i] = f.Path
		}
		return strings.Join(out, "、")
	}
	if c.Branch == nil || *c.Branch == "" {
		left := "没有"
		if len(c.Uncommitted) > 0 {
			left = paths(c.Uncommitted)
		}
		return fmt.Sprintf("它直接在项目 %s 里干活，没有分支可合。没提交的改动：%s", c.Project, left)
	}
	lines := []string{fmt.Sprintf("%s → %s 的 %s：%d 个提交，改了 %d 个文件。", *c.Branch, c.Project, c.Base, len(c.Commits), len(c.Files))}
	for _, x := range c.Commits[:min(len(c.Commits), 10)] {
		lines = append(lines, "- "+x.Hash+" "+x.Subject)
	}
	if len(c.Files) > 0 {
		files := make([]string, 0, min(len(c.Files), 30))
		for _, f := range c.Files[:min(len(c.Files), 30)] {
			counts := fmt.Sprintf("+%d −%d", f.Added, f.Removed)
			if f.Added < 0 {
				counts = "二进制"
			}
			files = append(files, f.Path+"（"+counts+"）")
		}
		lines = append(lines, "文件："+strings.Join(files, "、"))
	}
	if len(c.Uncommitted) > 0 {
		lines = append(lines, "还没提交（收获时会一起提交）："+paths(c.Uncommitted))
	}
	if c.Behind > 0 {
		lines = append(lines, fmt.Sprintf("这期间 %s 上多了 %d 个提交。", c.Base, c.Behind))
	}
	if len(c.Conflicts) > 0 {
		lines = append(lines, "合进去会冲突："+strings.Join(c.Conflicts, "、")+"。收获前要先让它解决。")
	} else {
		lines = append(lines, "能干净地合进去。")
	}
	return strings.Join(lines, "\n")
}

func managerDescribeSession(w session.Roster) string {
	h := w.Session
	last := ""
	if h.LastRun != nil {
		how := "停下了"
		switch h.LastRun.Outcome {
		case protocol.OutcomeCompleted:
			how = "做完了"
		case protocol.OutcomeFailed:
			how = "失败了"
		case protocol.OutcomeInterrupted:
		}
		last = "；上一轮" + how + "：" + str.Head(h.LastRun.Summary, 80)
	}
	where := "在 " + w.Place.Project
	if w.Place.Branch != "" {
		where = "在 " + w.Place.Project + " 的 " + w.Place.Branch
	}
	plan := ""
	if h.Playbook != nil {
		if h.Playbook.Node != nil {
			plan = "，做计划 " + h.Playbook.ID + " 的步骤 " + *h.Playbook.Node
		} else {
			plan = "，在拆计划 " + h.Playbook.ID
		}
	}
	spent := ""
	if h.Spent != nil {
		spent = "；花了" + spentText(*h.Spent)
	}
	return fmt.Sprintf("- %s（%s，%s，%s%s）工单「%s」，%s%s%s", h.Name, h.ID, protocol.RuntimeLabel(h.Runtime), where, plan,
		str.Head(h.Task, 60), protocol.PhaseText(h, clock.NowMs()), last, spent)
}

// Words in a helper's report or a page it read can ask for a merge; only the owner's can make one. The tool stays in the list, so that
// the prompt's prefix does not change from round to round.
const managerMergeNotAsked = "没合：合进主分支要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要收。"

var managerToolLabels = map[string]string{
	"dispatch":         "派活",
	"projects":         "项目",
	"channels":         "频道",
	"open_channel":     "开频道",
	"channel_settings": "改频道",
	"schedule":         "定时",
	"list_schedules":   "看定时",
	"cancel_schedule":  "取消定时",
	"merge":            "收获",
	"changes":          "看改动",
	"roster":           "花名册",
	"check":            "看进度",
	"tell":             "带话",
	"read_chat":        "看对话",
	"stop":             "叫停",
	"dismiss":          "收工",
	"plan":             "拆计划",
	"playbooks":        "看计划",
	"plan_edit":        "改计划",
	"plan_action":      "计划",
	"node_action":      "计划的一步",
	"remember":         "记一条",
	"rewrite_memory":   "整理记性",
	"search_archive":   "翻旧账",
	"memory_search":    "翻记性",
	"memory_add":       "替帮工记",
}

var managerNamed = []string{"agent", "session", "project", "name", "query", "note", "goal"}

func managerToolStart(name string, args json.RawMessage) session.ToolStart {
	var fields map[string]any
	_ = json.Unmarshal(args, &fields)
	about := ""
	for _, k := range managerNamed {
		if v, ok := fields[k].(string); ok && strings.TrimSpace(v) != "" {
			about = v
			break
		}
	}
	label := managerToolLabels[name]
	if label == "" {
		label = name
	}
	text := label
	if about != "" {
		if str.Units(about) > 40 {
			about = str.Head(about, 40) + "…"
		}
		text = label + "：" + about
	}
	input := "{}"
	if len(args) > 0 {
		var b bytes.Buffer
		if err := json.Compact(&b, args); err == nil {
			input = b.String()
		} else {
			input = string(args)
		}
	}
	return session.ToolStart{Text: text, Action: protocol.ToolActionOther, Tool: name, Input: input}
}

func managerThinkingOf(content []ai.Content) string {
	var parts []string
	for _, c := range content {
		if c.Type == ai.TypeThinking && !c.Redacted && strings.TrimSpace(c.Thinking) != "" {
			parts = append(parts, strings.TrimSpace(c.Thinking))
		}
	}
	return strings.Join(parts, "\n\n")
}

func managerScheduleLine(s protocol.Schedule, channel string) string {
	direct := ""
	if s.Agent != nil {
		direct = "，直接派给 " + *s.Agent
		if s.Project != nil {
			direct += " 去 " + *s.Project
		}
	}
	next := protocol.NextText(s)
	if s.Enabled {
		next = "下次 " + next
	}
	return fmt.Sprintf("- %s 号「%s」#%s %s%s；%s\n  %s", s.ID, s.Name, channel, protocol.WhenText(s.When, s.TZ), direct, next, s.Text)
}

func managerStr(description string) map[string]any {
	s := agentcore.StringSchema()
	if description != "" {
		s["description"] = description
	}
	return s
}

func managerEnum[T ~string](values []T) map[string]any {
	s := agentcore.StringSchema()
	enum := make([]any, len(values))
	for i, v := range values {
		enum[i] = string(v)
	}
	s["enum"] = enum
	return s
}

var managerSessionSchema = agentcore.ObjectSchema(map[string]any{"session": managerStr("帮工的名字或 id")}, "session")

type managerSessionArgs struct {
	Session string `json:"session"`
}

type managerNone struct{}

func managerAnswered(text string, err error) (string, error) {
	if err != nil {
		return "没成：" + err.Error(), nil
	}
	return text, nil
}

func (fm *manager) tools() []agentcore.AgentTool {
	// The manager may say either.
	findSession := func(key string) *session.Roster {
		all := fm.run.Roster()
		for _, pick := range []func(w session.Roster) bool{
			func(w session.Roster) bool { return w.Session.ID == key },
			func(w session.Roster) bool { return w.Session.Name == key },
			func(w session.Roster) bool { return strings.Contains(key, w.Session.Name) },
		} {
			if i := slices.IndexFunc(all, pick); i >= 0 {
				return &all[i]
			}
		}
		return nil
	}
	withSession := func(key string, run func(w session.Roster) string) (string, error) {
		w := findSession(key)
		if w == nil {
			return "没有叫 " + key + " 的帮工", nil
		}
		return run(*w), nil
	}
	sessionTool := func(name, description string, run func(w session.Roster) string) agentcore.AgentTool {
		return agent.TextTool(agent.TextToolSpec[managerSessionArgs]{
			Name: name, Label: managerToolLabels[name], Description: description, Parameters: managerSessionSchema,
			Run: func(_ context.Context, p managerSessionArgs, _ agent.ToolContext) (string, error) {
				return withSession(p.Session, run)
			},
		})
	}
	here := func() channel.Info { return fm.chat.ChannelOf(fm.here()) }

	type dispatchArgs struct {
		Task    string `json:"task"`
		Project string `json:"project"`
		Agent   string `json:"agent"`
		Channel string `json:"channel"`
	}
	dispatch := agent.TextTool(agent.TextToolSpec[dispatchArgs]{
		Name: "dispatch", Label: managerToolLabels["dispatch"],
		Description: "派一个帮工去某个项目里做一件事。task 是工单：目标、做到什么程度算完。project 是工作目录下的项目文件夹名（新项目就起一个简短的英文名，会新建）；频道有默认项目时可以不填。agent 填帮工的名字或 id，或 runtime 名；不填就按农场的规则挑。活派在你正在回话的频道里（工单串开在那里），要派到别的频道就填 channel。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"task":    managerStr("工单"),
			"project": managerStr("项目文件夹名，比如 clock-in"),
			"agent":   managerStr("帮工名字、id 或 runtime"),
			"channel": managerStr("派在哪个频道，比如 #clock-in；不填就是你正在回话的频道"),
		}, "task"),
		Run: func(ctx context.Context, p dispatchArgs, _ agent.ToolContext) (string, error) {
			var channel channel.Info
			if p.Channel != "" {
				named := fm.chat.ChannelByName(p.Channel)
				if named == nil {
					return "没有 " + p.Channel + " 这个频道：先用 channels 看看有哪些，或者用 open_channel 开一个。", nil
				}
				channel = *named
			} else {
				channel = here()
			}
			project := strings.TrimSpace(p.Project)
			if project == "" {
				project = channel.Project
			}
			if project == "" {
				return "#" + channel.Name + " 没有默认项目：dispatch 时填上 project。", nil
			}
			chosen := fm.choose(p.Task, p.Agent)
			if chosen == nil {
				return "没有能派的帮工：先去「帮工」页面建一个，或者把 runtime 装好。", nil
			}
			id := channel.ID
			hired := fm.issue.Hire(ctx, *chosen, p.Task, project, session.HireOptions{Channel: &id})
			if hired.Refused != "" || hired.Session == nil {
				fm.core.Notice(protocol.NoticeLevelWarn, hired.Refused)
				return "派不出去：" + hired.Refused, nil
			}
			h := hired.Session
			where := project
			if h.Project != nil {
				where = *h.Project
			}
			branch := ""
			if h.Branch != nil && *h.Branch != "" {
				branch = "，分支 " + *h.Branch
			}
			evicted := ""
			if hired.Evicted != "" {
				evicted = "为了腾地方，" + hired.Evicted + " 先收工了。"
			}
			return fmt.Sprintf("已在 #%s 派 %s（%s）去 %s%s。%s", channel.Name, h.Name, h.ID, where, branch, evicted), nil
		},
	})

	projects := agent.TextTool(agent.TextToolSpec[managerNone]{
		Name: "projects", Label: managerToolLabels["projects"], Description: "列出工作目录下的项目（每个文件夹是一个项目），以及是不是 git 仓库。",
		Parameters: agentcore.ObjectSchema(nil),
		Run: func(context.Context, managerNone, agent.ToolContext) (string, error) {
			all := fm.projects.List()
			if len(all) == 0 {
				return "工作目录（" + fm.projects.Root() + "）下还没有项目。", nil
			}
			lines := make([]string, len(all))
			for i, p := range all {
				lines[i] = "- " + p.Name
				if !p.Git {
					lines[i] += "（还不是 git 仓库，第一次派活时会建）"
				}
			}
			return strings.Join(lines, "\n"), nil
		},
	})

	channels := agent.TextTool(agent.TextToolSpec[managerNone]{
		Name: "channels", Label: managerToolLabels["channels"], Description: "列出频道：名字、是做什么的、默认项目。频道是安排活的地方，田头是默认的那个。",
		Parameters: agentcore.ObjectSchema(nil),
		Run: func(context.Context, managerNone, agent.ToolContext) (string, error) {
			all := fm.chat.Channels()
			lines := make([]string, len(all))
			for i, c := range all {
				lines[i] = "- #" + c.Name
				if c.Description != "" {
					lines[i] += "：" + c.Description
				}
				if c.Project != "" {
					lines[i] += "（默认项目 " + c.Project + "）"
				}
			}
			return strings.Join(lines, "\n"), nil
		},
	})

	type scheduleArgs struct {
		Name    string    `json:"name"`
		Text    string    `json:"text"`
		Kind    string    `json:"kind"`
		At      string    `json:"at"`
		Minutes *float64  `json:"minutes"`
		Time    string    `json:"time"`
		Days    []float64 `json:"days"`
		Cron    string    `json:"cron"`
		Channel string    `json:"channel"`
		Agent   string    `json:"agent"`
		Project string    `json:"project"`
		TZ      string    `json:"tz"`
	}
	schedule := agent.TextTool(agent.TextToolSpec[scheduleArgs]{
		Name: "schedule", Label: managerToolLabels["schedule"],
		Description: "定一件按时间来的事：到点时频道里出现一条「⏰ 定时」消息，然后你收到它照着做；填了 agent 就直接派那个帮工去做（工单就是 text），不经过你。kind：once（at 填 ISO 时间，带时区，比如 2026-10-13T09:00:00+08:00）、every（minutes 每隔几分钟，至少 1）、daily（time 填 HH:MM）、weekly（days 填周几，0 是周日，加 time）、cron（cron 填五段：分 时 日 月 周几，比如工作日 9 点是 0 9 * * 1-5，每月 1 号 10 点是 0 10 1 * *；前四种说不清的才用它）。text 写清楚到时候做什么、做完告诉谁。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"name":    managerStr("简短的名字，比如 每日测试"),
			"text":    managerStr("到点时说的话：要做的事"),
			"kind":    managerEnum([]string{"once", "every", "daily", "weekly", "cron"}),
			"at":      agentcore.StringSchema(),
			"minutes": agentcore.NumberSchema(),
			"time":    managerStr("HH:MM"),
			"days":    map[string]any{"type": "array", "items": agentcore.NumberSchema()},
			"cron":    managerStr("五段 cron：分 时 日 月 周几"),
			"channel": managerStr("在哪个频道，比如 #clock-in；不填是你正在回话的频道"),
			"agent":   managerStr("直接派给哪个帮工档案（名字或 id）；不填就是到点交给你"),
			"project": managerStr("直接派活时的项目；不填用频道的默认项目"),
			"tz":      managerStr("时区，比如 Asia/Shanghai；不填是这台电脑的"),
		}, "name", "text", "kind"),
		Run: func(_ context.Context, p scheduleArgs, _ agent.ToolContext) (string, error) {
			return managerAnswered(func() (string, error) {
				channel := here()
				if p.Channel != "" {
					named := fm.chat.ChannelByName(p.Channel)
					if named == nil {
						return "", errors.New("没有 " + p.Channel + " 这个频道：先用 channels 看看")
					}
					channel = *named
				}
				var when protocol.ScheduleWhenValue
				switch p.Kind {
				case "once":
					at, ok := managerParseTime(p.At)
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
				made, err := fm.schedule.Add(req)
				if err != nil {
					return "", err
				}
				return "定好了：\n" + managerScheduleLine(made, channel.Name), nil
			}())
		},
	})

	listSchedules := agent.TextTool(agent.TextToolSpec[managerNone]{
		Name: "list_schedules", Label: managerToolLabels["list_schedules"], Description: "列出定时：编号、在哪个频道、什么时候、下次什么时候、到点做什么。",
		Parameters: agentcore.ObjectSchema(nil),
		Run: func(context.Context, managerNone, agent.ToolContext) (string, error) {
			all := fm.schedule.List()
			if len(all) == 0 {
				return "没有定时。", nil
			}
			names := map[string]string{}
			for _, c := range fm.chat.Channels() {
				names[c.ID] = c.Name
			}
			lines := make([]string, len(all))
			for i, s := range all {
				name, ok := names[s.Channel]
				if !ok {
					name = "?"
				}
				lines[i] = managerScheduleLine(s, name)
			}
			return strings.Join(lines, "\n"), nil
		},
	})

	type idArgs struct {
		ID string `json:"id"`
	}
	cancelSchedule := agent.TextTool(agent.TextToolSpec[idArgs]{
		Name: "cancel_schedule", Label: managerToolLabels["cancel_schedule"], Description: "删掉一个定时（编号从 list_schedules 看）。",
		Parameters: agentcore.ObjectSchema(map[string]any{"id": agentcore.StringSchema()}, "id"),
		Run: func(_ context.Context, p idArgs, _ agent.ToolContext) (string, error) {
			s, err := fm.schedule.Remove(p.ID)
			return managerAnswered("删掉了「"+s.Name+"」。", err)
		},
	})

	type openArgs struct {
		Name        string `json:"name"`
		Description string `json:"description,omitempty"`
		Project     string `json:"project,omitempty"`
	}
	openChannel := agent.TextTool(agent.TextToolSpec[openArgs]{
		Name: "open_channel", Label: managerToolLabels["open_channel"],
		Description: "开一个新频道：一件长期的事、一个项目，单独一个地方说话、派活。name 是频道名（字母、数字、汉字、- 和 _），description 写它是做什么的，project 是它的默认项目（在这里派的活默认在这个项目里干）。主人要求了才开。",
		Parameters:  managerSchema[openArgs](),
		Run: func(_ context.Context, p openArgs, _ agent.ToolContext) (string, error) {
			c, err := fm.chat.OpenChannel(p.Name, p.Description, p.Project)
			if err != nil {
				return "", err
			}
			project := ""
			if c.Project != "" {
				project = "，默认项目 " + c.Project
			}
			return "开好了 #" + c.Name + project + "。", nil
		},
	})

	type settingsArgs struct {
		Channel     string  `json:"channel"`
		Description *string `json:"description"`
		Project     *string `json:"project"`
	}
	channelSettings := agent.TextTool(agent.TextToolSpec[settingsArgs]{
		Name: "channel_settings", Label: managerToolLabels["channel_settings"],
		Description: "改一个频道是做什么的（description），或它的默认项目（project，写空字符串就是不要默认项目）。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"channel": agentcore.StringSchema(), "description": agentcore.StringSchema(), "project": agentcore.StringSchema(),
		}, "channel"),
		Run: func(_ context.Context, p settingsArgs, _ agent.ToolContext) (string, error) {
			c := fm.chat.ChannelByName(p.Channel)
			if c == nil {
				return "", errors.New("没有 " + p.Channel + " 这个频道")
			}
			if err := fm.chat.UpdateChannel(c.ID, p.Description, p.Project); err != nil {
				return "", err
			}
			return "改好了 #" + c.Name + "。", nil
		},
	})

	merge := sessionTool("merge", "把一个帮工分支上的提交合进它所在项目的主分支，然后让它收工。会冲突时不合并，帮工留在地里，结果里有让它解决冲突的话。",
		func(w session.Roster) string {
			if !fm.requestInput().Owner {
				return managerMergeNotAsked
			}
			if w.Session.Issue == nil {
				return "这个帮工没有工单"
			}
			said, err := fm.issue.Merge(*w.Session.Issue)
			if err != nil {
				return err.Error()
			}
			return said
		})
	changes := agent.TextTool(agent.TextToolSpec[managerSessionArgs]{
		Name: "changes", Label: managerToolLabels["changes"], Parameters: managerSessionSchema,
		Description: "看收获一个帮工会合进项目什么：它的提交、改了哪些文件（加减行数）、没提交的改动、会不会冲突。主人问「改了什么」或者收获前想确认时用。",
		Run: func(_ context.Context, p managerSessionArgs, _ agent.ToolContext) (string, error) {
			return withSession(p.Session, func(w session.Roster) string {
				if w.Session.Issue == nil {
					return "这个帮工没有工单"
				}
				c, err := fm.issue.Changes(*w.Session.Issue, protocol.CallerManager)
				if err != nil {
					return "看不了改动：" + err.Error()
				}
				return managerDescribeChanges(c)
			})
		},
	})
	roster := agent.TextTool(agent.TextToolSpec[managerNone]{
		Name: "roster", Label: managerToolLabels["roster"], Description: "列出地里所有帮工：在做什么、上一轮的结果。",
		Parameters: agentcore.ObjectSchema(nil),
		Run: func(context.Context, managerNone, agent.ToolContext) (string, error) {
			all := fm.run.Roster()
			if len(all) == 0 {
				return "地里现在没有帮工。", nil
			}
			lines := make([]string, len(all))
			for i, w := range all {
				lines[i] = managerDescribeSession(w)
			}
			return strings.Join(lines, "\n"), nil
		},
	})
	check := sessionTool("check", "看一个帮工的详细情况和上一轮的完整汇报。", func(w session.Roster) string {
		last := "还没有"
		if w.LastText != "" {
			last = managerTail(w.LastText, 2000)
		}
		return managerDescribeSession(w) + "\n目录：" + w.Place.Cwd + "\n上一轮完整汇报（结尾部分）：\n" + last
	})

	type tellArgs struct {
		Session string `json:"session" jsonschema:"帮工的名字或 id"`
		Message string `json:"message" jsonschema:"要带的话"`
	}
	tell := agent.TextTool(agent.TextToolSpec[tellArgs]{
		Name: "tell", Label: managerToolLabels["tell"], Description: "给一个帮工带话：发在它的工单串里。他正在干就插进去（不能插话的 runtime 会排到这一轮之后），空闲就开新的一轮。",
		Parameters: managerSchema[tellArgs](),
		Run: func(_ context.Context, p tellArgs, _ agent.ToolContext) (string, error) {
			return withSession(p.Session, func(w session.Roster) string {
				if _, err := fm.chat.TellSession(protocol.ManagerAgent, w.Session.ID, p.Message); err != nil {
					return "没带到：" + err.Error()
				}
				return "已经在 " + w.Session.Name + " 的工单串里说了"
			})
		},
	})

	type readArgs struct {
		Target string `json:"target,omitempty" jsonschema:"#田头、#clock-in，或 #田头:<消息号>"`
	}
	readChat := agent.TextTool(agent.TextToolSpec[readArgs]{
		Name: "read_chat", Label: managerToolLabels["read_chat"], Description: "读一个频道或一个串里最近说的话。target 写 #<频道>（比如 #田头），或 #<频道>:<消息号>（一个串）；不填就是你正在回话的地方。",
		Parameters: managerSchema[readArgs](),
		Run: func(_ context.Context, p readArgs, _ agent.ToolContext) (string, error) {
			where := p.Target
			if where == "" {
				where = "#" + here().Name
			}
			r, err := fm.chat.Read(protocol.ManagerAgent, channel.ReadOptions{Target: where})
			if err != nil {
				return "读不了：" + err.Error(), nil
			}
			if len(r.Messages) == 0 {
				return r.Target + " 里还没有话", nil
			}
			older := ""
			if r.Older {
				older = "（更早的没列出）"
			}
			return r.Target + older + "：\n" + protocol.InboxLines(r.Messages), nil
		},
	})

	stop := sessionTool("stop", "叫停一个帮工正在做的这一轮。", func(w session.Roster) string {
		if fm.run.Stop(w.Session.ID) {
			return w.Session.Name + " 停下了"
		}
		return w.Session.Name + " 现在没在干活"
	})
	dismiss := sessionTool("dismiss", "让一个帮工收工离开农场。", func(w session.Roster) string {
		fm.run.Dismiss(w.Session.ID)
		return w.Session.Name + " 收工了"
	})

	type planArgs struct {
		Goal    string `json:"goal"`
		Project string `json:"project"`
		Agent   string `json:"agent"`
	}
	plan := agent.TextTool(agent.TextToolSpec[planArgs]{
		Name: "plan", Label: managerToolLabels["plan"],
		Description: "起一个种植计划：派一个帮工读代码，把一件很长的活拆成几步（每步一个帮工，有先后），拆好了等主人看过再开工。goal 是主人要做的事，照他的原话写全；project 是项目文件夹名。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"goal":    managerStr("要做的事，照主人的原话"),
			"project": managerStr("项目文件夹名"),
			"agent":   managerStr("让谁来拆：帮工名字或 id；不填按规则挑"),
		}, "goal", "project"),
		Run: func(_ context.Context, p planArgs, _ agent.ToolContext) (string, error) {
			return managerAnswered(fm.playbooks.Plan(p.Goal, p.Project, p.Agent, protocol.PlaybookActorManager))
		},
	})

	type playbooksArgs struct {
		ID string `json:"id"`
	}
	playbooks := agent.TextTool(agent.TextToolSpec[playbooksArgs]{
		Name: "playbooks", Label: managerToolLabels["playbooks"], Description: "列出种植计划：每一步的状态、谁在做、结论。",
		Parameters: agentcore.ObjectSchema(map[string]any{"id": managerStr("计划 id，比如 p1；不填列出所有没收完的")}),
		Run: func(_ context.Context, p playbooksArgs, _ agent.ToolContext) (string, error) {
			var texts []string
			for _, pb := range protocol.PlaybooksOf(fm.core.State()) {
				if (p.ID != "" && pb.ID == p.ID) || (p.ID == "" && protocol.IsOpen(pb)) {
					texts = append(texts, protocol.PlaybookText(pb))
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

	type editArgs struct {
		Playbook string   `json:"playbook"`
		Node     string   `json:"node"`
		Title    *string  `json:"title"`
		Task     *string  `json:"task"`
		Needs    []string `json:"needs"`
		Agent    *string  `json:"agent"`
		Check    *string  `json:"check"`
		Remove   bool     `json:"remove"`
	}
	planEdit := agent.TextTool(agent.TextToolSpec[editArgs]{
		Name: "plan_edit", Label: managerToolLabels["plan_edit"],
		Description: "改计划里的一步：工单、标题、要等的步骤、谁来做、做完跑的检查命令；没有这一步就加上。remove 为 true 时删掉这一步。没开工的计划什么都能改；开工以后只能改还没开始或没做成的步骤。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"playbook": managerStr("计划 id"),
			"node":     managerStr("步骤 id（新步骤就起一个简短的英文 id）"),
			"title":    agentcore.StringSchema(),
			"task":     managerStr("工单"),
			"needs":    map[string]any{"type": "array", "items": agentcore.StringSchema(), "description": "要等哪些步骤做完"},
			"agent":    managerStr("帮工档案 id；空字符串表示按规则挑"),
			"check":    managerStr("做完跑的检查命令；空字符串表示不跑"),
			"remove":   agentcore.BooleanSchema(),
		}, "playbook", "node"),
		Run: func(_ context.Context, p editArgs, _ agent.ToolContext) (string, error) {
			if p.Remove {
				return managerAnswered(fm.playbooks.RemoveNode(p.Playbook, p.Node, protocol.PlaybookActorManager))
			}
			edit := protocol.NodeEdit{Title: p.Title, Task: p.Task, Needs: p.Needs, Agent: p.Agent, Check: p.Check}
			return managerAnswered(fm.playbooks.EditNode(p.Playbook, p.Node, edit, protocol.PlaybookActorManager))
		},
	})

	type actArgs struct {
		Playbook string `json:"playbook"`
		Action   string `json:"action"`
	}
	planAction := agent.TextTool(agent.TextToolSpec[actArgs]{
		Name: "plan_action", Label: managerToolLabels["plan_action"],
		Description: "对整个计划：start 开工（主人看过、同意了才用），pause 暂停（正在做的做完，不开新的），resume 继续，abandon 放弃（分支留着），merge 收获（都做完以后，把计划分支合进主分支）。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"playbook": managerStr("计划 id"), "action": managerEnum(protocol.PlaybookActionValues)}, "playbook", "action"),
		Run: func(_ context.Context, p actArgs, _ agent.ToolContext) (string, error) {
			if protocol.PlaybookAction(p.Action) == protocol.PlaybookActionMerge && !fm.requestInput().Owner {
				return managerMergeNotAsked, nil
			}
			return managerAnswered(fm.playbooks.Act(p.Playbook, protocol.PlaybookAction(p.Action), protocol.PlaybookActorManager))
		},
	})

	type nodeActArgs struct {
		Playbook string `json:"playbook"`
		Node     string `json:"node"`
		Action   string `json:"action"`
	}
	nodeAction := agent.TextTool(agent.TextToolSpec[nodeActArgs]{
		Name: "node_action", Label: managerToolLabels["node_action"], Description: "对计划里的一步：retry 重试没做成的步骤，skip 跳过它（后面的步骤照常开工）。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"playbook": managerStr("计划 id"), "node": managerStr("步骤 id"), "action": managerEnum(protocol.NodeActionValues),
		}, "playbook", "node", "action"),
		Run: func(_ context.Context, p nodeActArgs, _ agent.ToolContext) (string, error) {
			return managerAnswered(fm.playbooks.NodeAct(p.Playbook, p.Node, protocol.NodeAction(p.Action), protocol.PlaybookActorManager))
		},
	})

	// The manager may say a profile's name or id; its own memory is MEMORY.md (remember), not one of these.
	profile := func(key string) (string, error) {
		key = strings.TrimSpace(key)
		if key == protocol.ManagerAgent || key == "管家" {
			return "", errors.New("你自己的记性在系统提示里：要记用 remember，要找旧对话用 search_archive")
		}
		for _, a := range fm.store.Agents() {
			if a.ID == key || a.Name == key {
				return a.ID, nil
			}
		}
		return "", errors.New("没有叫 " + key + " 的帮工档案")
	}

	type memorySearchArgs struct {
		Query   string `json:"query"`
		Agent   string `json:"agent"`
		Project string `json:"project"`
	}
	memorySearch := agent.TextTool(agent.TextToolSpec[memorySearchArgs]{
		Name: "memory_search", Label: managerToolLabels["memory_search"],
		Description: "在帮工档案的记性里找：它们记下的话、主人替它们记的、做过的活。agent 不填就找所有档案；project 只找那个项目的和所有项目都用的。派活前想知道某个项目有什么约定、谁做过类似的活时用。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"query":   managerStr("要找什么，几个词或一句话；不填就列出最新的"),
			"agent":   managerStr("帮工档案的名字或 id"),
			"project": managerStr("项目文件夹名"),
		}),
		Run: func(_ context.Context, p memorySearchArgs, _ agent.ToolContext) (string, error) {
			q := memory.SearchQuery{Text: p.Query, Project: strings.TrimSpace(p.Project)}
			if strings.TrimSpace(p.Agent) != "" {
				id, err := profile(p.Agent)
				if err != nil {
					return managerAnswered("", err)
				}
				q.Agent = id
			}
			return memory.FoundText(fm.memory.Search(q), q), nil
		},
	})

	type memoryAddArgs struct {
		Agent   string `json:"agent"`
		Text    string `json:"text"`
		Project string `json:"project"`
	}
	memoryAdd := agent.TextTool(agent.TextToolSpec[memoryAddArgs]{
		Name: "memory_add", Label: managerToolLabels["memory_add"],
		Description: "替一个帮工档案记一句，它以后派出去的帮工开工时会想起。主人要某个帮工以后都记得一件事时用；不填 project 就是所有项目都用。主人对你自己说的偏好用 remember。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"agent":   managerStr("帮工档案的名字或 id"),
			"text":    managerStr("要它记住的一句话"),
			"project": managerStr("只在这个项目里用：项目文件夹名"),
		}, "agent", "text"),
		Run: func(_ context.Context, p memoryAddArgs, _ agent.ToolContext) (string, error) {
			id, err := profile(p.Agent)
			if err != nil {
				return managerAnswered("", err)
			}
			m, err := fm.memory.Remember(id, p.Text, p.Project)
			if err != nil {
				return managerAnswered("", err)
			}
			where := "所有项目"
			if m.Project != nil {
				where = "项目 " + *m.Project
			}
			return "替 " + id + " 记下了（" + where + "）〔" + m.ID + "〕", nil
		},
	})

	return []agentcore.AgentTool{
		dispatch, projects, channels, schedule, listSchedules, cancelSchedule, openChannel, channelSettings, merge, changes,
		roster, check, tell, readChat, stop, dismiss, plan, playbooks, planEdit, planAction, nodeAction, memorySearch, memoryAdd,
	}
}

// The way JS's Date reads the forms a model writes.
func managerParseTime(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05Z0700", "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	// Without a zone, a date-time is local time; a date alone is UTC midnight (as JS reads them).
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t.UnixMilli(), true
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.UnixMilli(), true
	}
	return 0, false
}
