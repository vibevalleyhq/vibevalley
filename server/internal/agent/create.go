package agent

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"vibevalley/internal/protocol"
)

func (st *Service) CreateAgent(draft protocol.Agent) (protocol.Agent, error) {
	if draft.ID != "" {
		return protocol.Agent{}, protocol.Refused{Reason: "新档案的 id 要留空；指定 id 请用保存"}
	}
	var created protocol.Agent
	err := st.change(func(s *stored) {
		n := 1
		for slices.ContainsFunc(s.Agents, func(a protocol.Agent) bool { return a.ID == fmt.Sprintf("agent-%d", n) }) {
			n++
		}
		draft.ID = fmt.Sprintf("agent-%d", n)
		created = withCast(draft)
		s.Agents = append(s.Agents, created)
	})
	return created, err
}

var skillWords = regexp.MustCompile(`[^a-z0-9]+`)

func (st *Service) CreateSkill(draft protocol.Skill) (protocol.Skill, error) {
	if draft.ID != "" {
		return protocol.Skill{}, protocol.Refused{Reason: "新技能的 id 要留空；指定 id 请用保存"}
	}
	var created protocol.Skill
	err := st.change(func(s *stored) {
		stem := strings.Trim(skillWords.ReplaceAllString(strings.ToLower(draft.Name), "-"), "-")
		if stem == "" {
			stem = "skill"
		}
		id := stem
		for n := 2; slices.ContainsFunc(s.Skills, func(k protocol.Skill) bool { return k.ID == id }); n++ {
			id = fmt.Sprintf("%s-%d", stem, n)
		}
		created = draft
		created.ID = id
		s.Skills = append(s.Skills, created)
	})
	return created, err
}
