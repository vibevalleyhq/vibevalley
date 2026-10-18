package tool

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

// Looking at the farm: projects, channels, who is in the fields, what a session would merge.

func (s *Service) projectsTool() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[none]{
		Name: "projects", Label: labels["projects"], Description: "列出工作目录下的项目（每个文件夹是一个项目），以及是不是 git 仓库。",
		Parameters: schemaOf[none](),
		Run: func(context.Context, none, brain.ToolContext) (string, error) {
			all := s.projects.List()
			if len(all) == 0 {
				return "工作目录（" + s.projects.Root() + "）下还没有项目。", nil
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
}

func (s *Service) channelsTool() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[none]{
		Name: "channels", Label: labels["channels"], Description: "列出频道：名字、是做什么的、默认项目。频道是安排活的地方，田头是默认的那个。",
		Parameters: schemaOf[none](),
		Run: func(context.Context, none, brain.ToolContext) (string, error) {
			all := s.chat.Channels()
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
}

func (s *Service) roster() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[none]{
		Name: "roster", Label: labels["roster"], Description: "列出地里所有帮工：在做什么、上一轮的结果。",
		Parameters: schemaOf[none](),
		Run: func(context.Context, none, brain.ToolContext) (string, error) {
			all := s.run.Roster()
			if len(all) == 0 {
				return "地里现在没有帮工。", nil
			}
			lines := make([]string, len(all))
			for i, w := range all {
				lines[i] = sessionLine(w)
			}
			return strings.Join(lines, "\n"), nil
		},
	})
}

func (s *Service) check() agentcore.AgentTool {
	return s.sessionTool("check", "看一个帮工的详细情况和上一轮的完整汇报。", func(w session.Roster) string {
		last := "还没有"
		if w.LastText != "" {
			last = tail(w.LastText, 2000)
		}
		return sessionLine(w) + "\n目录：" + w.Place.Cwd + "\n上一轮完整汇报（结尾部分）：\n" + last
	})
}

func (s *Service) changes() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[sessionArgs]{
		Name: "changes", Label: labels["changes"], Parameters: schemaOf[sessionArgs](),
		Description: "看收获一个帮工会合进项目什么：它的提交、改了哪些文件（加减行数）、没提交的改动、会不会冲突。主人问「改了什么」或者收获前想确认时用。",
		Run: func(_ context.Context, p sessionArgs, _ brain.ToolContext) (string, error) {
			return s.withSession(p.Session, func(w session.Roster) string {
				if w.Session.Issue == nil {
					return "这个帮工没有工单"
				}
				c, err := s.issue.Changes(*w.Session.Issue, protocol.CallerManager)
				if err != nil {
					return "看不了改动：" + err.Error()
				}
				return changesText(c)
			})
		},
	})
}

var spaces = regexp.MustCompile(`\s+`)

func (s *Service) sessionList() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[none]{
		Name: "session_list", Description: "地里现在有谁：每个帮工的编号、名字、农机、在哪个项目、在做什么。",
		Parameters: schemaOf[none](),
		Run: func(context.Context, none, brain.ToolContext) (string, error) {
			// Listed without @: an @ wakes someone, and models copy what they read.
			lines := []string{"地里有主人、管家，和这些帮工："}
			for _, h := range s.core.State().Sessions {
				doing := protocol.PhaseText(h, clock.NowMs())
				project := "?"
				if h.Project != nil {
					project = *h.Project
				}
				task := str.Head(spaces.ReplaceAllString(h.Brief, " "), 60)
				lines = append(lines, fmt.Sprintf("- %s %s（%s，在 %s；%s）工单：%s", h.ID, h.Name, h.Runtime, project, doing, task))
			}
			lines = append(lines, "要叫醒谁，就在 channel_say 的话里写 @ 加编号（如 @w3）、@管家、@主人；只是提到，不带 @。")
			return strings.Join(lines, "\n"), nil
		},
	})
}
