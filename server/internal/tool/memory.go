package tool

import (
	"context"
	"errors"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Memory: what a profile remembers. The manager reads and writes any helper profile's; a session only its own, in the
// project it works in. Its own memory the manager keeps in MEMORY.md (remember), not here.

// The manager may say a profile's name or id.
func (s *Service) profile(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == protocol.ManagerAgent || key == "管家" {
		return "", errors.New("你自己的记性在系统提示里：要记用 remember，要找旧对话用 search_archive")
	}
	for _, a := range s.agents.Agents() {
		if a.ID == key || a.Name == key {
			return a.ID, nil
		}
	}
	return "", errors.New("没有叫 " + key + " 的帮工档案")
}

var errNotWorking = errors.New("地里没有你：记性只给在干活的帮工用")

type managerSearchArgs struct {
	Query   string `json:"query,omitempty" jsonschema:"要找什么，几个词或一句话；不填就列出最新的"`
	Agent   string `json:"agent,omitempty" jsonschema:"帮工档案的名字或 id"`
	Project string `json:"project,omitempty" jsonschema:"项目文件夹名"`
}

type sessionSearchArgs struct {
	Query       string `json:"query,omitempty" jsonschema:"要找什么，几个词或一句话；不填就列出最新的"`
	AllProjects bool   `json:"all_projects,omitempty" jsonschema:"也找别的项目里记下的"`
}

func (s *Service) memorySearch(who Who, k kind) agentcore.AgentTool {
	if k == forManager {
		return brain.TextTool(brain.TextToolSpec[managerSearchArgs]{
			Name: "memory_search", Label: labels["memory_search"],
			Description: "在帮工档案的记性里找：它们记下的话、主人替它们记的、做过的活。agent 不填就找所有档案；project 只找那个项目的和所有项目都用的。派活前想知道某个项目有什么约定、谁做过类似的活时用。",
			Parameters:  schemaOf[managerSearchArgs](),
			Run: func(_ context.Context, p managerSearchArgs, _ brain.ToolContext) (string, error) {
				q := memory.SearchQuery{Text: p.Query, Project: strings.TrimSpace(p.Project)}
				if strings.TrimSpace(p.Agent) != "" {
					id, err := s.profile(p.Agent)
					if err != nil {
						return answered("", err)
					}
					q.Agent = id
				}
				return memory.FoundText(s.memory.Search(q), q), nil
			},
		})
	}
	return brain.TextTool(brain.TextToolSpec[sessionSearchArgs]{
		Name: "memory_search", Label: labels["memory_search"],
		Description: "在你的记性里找：你和主人以前替你的档案记下的话、做过的活。只找这个项目的和所有项目都用的；all_projects 也找别的项目的。干到一半想知道「这个项目的测试怎么跑」「上次这个坑怎么绕过去的」时用。",
		Parameters:  schemaOf[sessionSearchArgs](),
		Run: func(ctx context.Context, p sessionSearchArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			if c.Agent == "" {
				return "", errNotWorking
			}
			q := memory.SearchQuery{Agent: c.Agent, Project: c.Project, Text: p.Query}
			if p.AllProjects {
				q.Project = ""
			}
			return memory.FoundText(s.memory.Search(q), q), nil
		},
	})
}

type managerAddArgs struct {
	Agent   string `json:"agent" jsonschema:"帮工档案的名字或 id"`
	Text    string `json:"text" jsonschema:"要它记住的一句话"`
	Project string `json:"project,omitempty" jsonschema:"只在这个项目里用：项目文件夹名"`
}

type sessionAddArgs struct {
	Text        string `json:"text" jsonschema:"一句以后还用得上的话：约定、坑、命令"`
	AllProjects bool   `json:"all_projects,omitempty" jsonschema:"所有项目都用得上，不只是这个项目"`
	Agent       string `json:"agent,omitempty" jsonschema:"不用填：只能记进你自己的档案"`
}

func (s *Service) memoryAdd(who Who, k kind) agentcore.AgentTool {
	if k == forManager {
		return brain.TextTool(brain.TextToolSpec[managerAddArgs]{
			Name: "memory_add", Label: labels["memory_add"],
			Description: "替一个帮工档案记一句，它以后派出去的帮工开工时会想起。主人要某个帮工以后都记得一件事时用；不填 project 就是所有项目都用。主人对你自己说的偏好用 remember。",
			Parameters:  schemaOf[managerAddArgs](),
			Run: func(_ context.Context, p managerAddArgs, _ brain.ToolContext) (string, error) {
				id, err := s.profile(p.Agent)
				if err != nil {
					return answered("", err)
				}
				m, err := s.memory.Remember(memory.Note{Agent: id, Text: p.Text, Project: p.Project, By: protocol.MemoryAuthorManager})
				if err != nil {
					return answered("", err)
				}
				return "替 " + id + " 记下了（" + memoryWhere(m) + "）〔" + m.ID + "〕", nil
			},
		})
	}
	return brain.TextTool(brain.TextToolSpec[sessionAddArgs]{
		Name: "memory_add", Label: labels["memory_add"],
		Description: "往你的记性里记一句，你的档案以后派出去的帮工开工时会想起。记这个项目的；all_projects 记成所有项目都用的。只记以后还用得上的：约定、坑、命令，不记这一次的进度。",
		Parameters:  schemaOf[sessionAddArgs](),
		Run: func(ctx context.Context, p sessionAddArgs, _ brain.ToolContext) (string, error) {
			c, err := who(ctx)
			if err != nil {
				return "", err
			}
			if c.Agent == "" {
				return "", errNotWorking
			}
			if p.Agent != "" && p.Agent != c.Agent {
				return "", errors.New("只能记进你自己的档案（" + c.Agent + "），" + p.Agent + " 的记性不归你写")
			}
			project := c.Project
			if p.AllProjects {
				project = ""
			}
			m, err := s.memory.Remember(memory.Note{Agent: c.Agent, Text: p.Text, Project: project, By: protocol.MemoryAuthorAgent, Session: c.Session})
			if err != nil {
				return "", err
			}
			return "记下了（" + memoryWhere(m) + "）〔" + m.ID + "〕", nil
		},
	})
}

func memoryWhere(m protocol.Memory) string {
	if m.Project != nil {
		return "项目 " + *m.Project
	}
	return "所有项目"
}
