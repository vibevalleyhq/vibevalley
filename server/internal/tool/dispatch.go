package tool

import (
	"context"
	"fmt"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/channel"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/agentcore"
)

// Dispatching: sending helpers out, passing words to them, merging, stopping and dismissing them.

// Which profile takes a task: the one named, else the one the owner picked for this input, else by the farm's rule.
func (s *Service) choose(ctx context.Context, task, named, picked string) *protocol.Agent {
	var candidates []session.Candidate
	for _, a := range s.agents.Agents() {
		assessed := s.runtimes.Assess(ctx, a)
		candidates = append(candidates, session.Candidate{Agent: assessed.Agent, Usable: assessed.Usable()})
	}
	return session.ChooseAgent(candidates, task, named, picked)
}

type dispatchArgs struct {
	Brief   string `json:"brief" jsonschema:"工单"`
	Project string `json:"project,omitempty" jsonschema:"项目文件夹名，比如 clock-in"`
	Agent   string `json:"agent,omitempty" jsonschema:"帮工名字、id 或 runtime"`
	Channel string `json:"channel,omitempty" jsonschema:"派在哪个频道，比如 #clock-in；不填就是你正在回话的频道"`
}

func (s *Service) dispatch(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[dispatchArgs]{
		Name: "dispatch", Label: labels["dispatch"],
		Description: "派一个帮工去某个项目里做一件事。brief 是工单：目标、做到什么程度算完。project 是工作目录下的项目文件夹名（新项目就起一个简短的英文名，会新建）；频道有默认项目时可以不填。agent 填帮工的名字或 id，或 runtime 名；不填就按农场的规则挑。活派在你正在回话的频道里（工单串开在那里），要派到别的频道就填 channel。",
		Parameters:  schemaOf[dispatchArgs](),
		Run: func(ctx context.Context, p dispatchArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			var channel channel.Info
			if p.Channel != "" {
				named := s.chat.ChannelByName(p.Channel)
				if named == nil {
					return "没有 " + p.Channel + " 这个频道：先用 channels 看看有哪些，或者用 open_channel 开一个。", nil
				}
				channel = *named
			} else {
				channel = s.chat.ChannelOf(c.Here)
			}
			project := strings.TrimSpace(p.Project)
			if project == "" {
				project = channel.Project
			}
			if project == "" {
				return "#" + channel.Name + " 没有默认项目：dispatch 时填上 project。", nil
			}
			chosen := s.choose(ctx, p.Brief, p.Agent, c.Picked)
			if chosen == nil {
				return "没有能派的帮工：先去「帮工」页面建一个，或者把 runtime 装好。", nil
			}
			id := channel.ID
			hired := s.issue.Hire(ctx, *chosen, p.Brief, project, session.HireOptions{Channel: &id})
			if hired.Refused != "" || hired.Session == nil {
				s.core.Notice(protocol.NoticeLevelWarn, hired.Refused)
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
}

// Words in a helper's report or a page it read can ask for a merge; only the owner's can make one. The tool stays in the
// list, so that the prompt's prefix does not change from round to round.
func (s *Service) merge(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[sessionArgs]{
		Name: "merge", Label: labels["merge"], Parameters: schemaOf[sessionArgs](),
		Description: "把一个帮工分支上的提交合进它所在项目的主分支，然后让它收工。会冲突时不合并，帮工留在地里，结果里有让它解决冲突的话。",
		Run: func(ctx context.Context, p sessionArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			return s.withSession(p.Session, func(w session.Roster) string {
				if !c.Owner {
					return mergeNotAsked
				}
				if w.Session.Issue == nil {
					return "这个帮工没有工单"
				}
				// Every issue has an acceptance; a required one must have passed before anything is harvested.
				if t, err := s.issue.Get(*w.Session.Issue); err == nil && t.Acceptance == protocol.AcceptanceRequired && t.AcceptedAt == nil {
					return "这张工单要先过验收：先用 accept 验收通过，才能收获"
				}
				said, err := s.issue.Merge(*w.Session.Issue)
				if err != nil {
					return err.Error()
				}
				return said
			})
		},
	})
}

type acceptArgs struct {
	Session  string   `json:"session" jsonschema:"帮工的名字或 id"`
	Pass     bool     `json:"pass" jsonschema:"验收过了就是 true"`
	Findings []string `json:"findings,omitempty" jsonschema:"没过时，每条要修的一句话"`
	Text     string   `json:"text,omitempty" jsonschema:"没过时，还要交代的话"`
}

// Acceptance is judging what came back against what the issue asked for; a pass only makes it ready, the harvest
// stays the owner's (merge).
func (s *Service) accept() agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[acceptArgs]{
		Name: "accept", Label: labels["accept"], Parameters: schemaOf[acceptArgs](),
		Description: "验收一个帮工交回来的活：先用 changes 看改动，对着工单要的逐条看。过了（pass: true）就能收获；没过就把每条要修的写进 findings，它会带着这些接着修一轮。",
		Run: func(ctx context.Context, p acceptArgs, _ brain.ToolContext) (string, error) {
			return s.withSession(p.Session, func(w session.Roster) string {
				if w.Session.Issue == nil {
					return "这个帮工没有工单"
				}
				t, err := s.issue.Accept(ctx, *w.Session.Issue, protocol.IssueAcceptRequest{Pass: p.Pass, Findings: p.Findings, Text: p.Text})
				if err != nil {
					return err.Error()
				}
				if p.Pass {
					return fmt.Sprintf("「%s」验收过了，等主人收获", t.Title)
				}
				return fmt.Sprintf("「%s」没过验收，%d 处要修，已经交回给它", t.Title, protocol.OpenFindings(t))
			})
		},
	})
}

type tellArgs struct {
	Session string `json:"session" jsonschema:"帮工的名字或 id"`
	Message string `json:"message" jsonschema:"要带的话"`
}

func (s *Service) tell(who Who) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[tellArgs]{
		Name: "tell", Label: labels["tell"], Description: "给一个帮工带话：发在它的工单串里。他正在干就插进去（不能插话的 runtime 会排到这一轮之后），空闲就开新的一轮。",
		Parameters: schemaOf[tellArgs](),
		Run: func(ctx context.Context, p tellArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			return s.withSession(p.Session, func(w session.Roster) string {
				if _, err := s.chat.TellSession(c.participant(), w.Session.ID, p.Message); err != nil {
					return "没带到：" + err.Error()
				}
				return "已经在 " + w.Session.Name + " 的工单串里说了"
			})
		},
	})
}

func (s *Service) stop() agentcore.AgentTool {
	return s.sessionTool("stop", "叫停一个帮工正在做的这一轮。", func(w session.Roster) string {
		if s.run.Stop(w.Session.ID) {
			return w.Session.Name + " 停下了"
		}
		return w.Session.Name + " 现在没在干活"
	})
}

func (s *Service) dismiss() agentcore.AgentTool {
	return s.sessionTool("dismiss", "让一个帮工收工离开农场。", func(w session.Roster) string {
		s.run.Dismiss(w.Session.ID)
		return w.Session.Name + " 收工了"
	})
}
