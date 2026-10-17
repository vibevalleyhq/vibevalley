package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
)

type stored struct {
	Agents   []protocol.Agent                    `json:"agents"`
	Skills   []protocol.Skill                    `json:"skills"`
	Settings map[string]protocol.RuntimeSettings `json:"settings"`
}

type Service struct {
	Home string
	mu   sync.Mutex
	s    stored
	disk *base.FileWriter
}

// Only where they are still exactly as seeded.
func withoutExamples(s stored) stored {
	examples := protocol.ExampleSkills()
	untouched := func(k protocol.Skill) bool {
		return slices.ContainsFunc(examples, func(e protocol.Skill) bool { return reflect.DeepEqual(e, k) })
	}
	skills := slices.DeleteFunc(slices.Clone(s.Skills), untouched)
	if len(skills) == len(s.Skills) {
		return s
	}
	kept := map[string]bool{}
	for _, k := range skills {
		kept[k.ID] = true
	}
	agents := slices.Clone(s.Agents)
	for i, a := range agents {
		agents[i].Skills = slices.DeleteFunc(slices.Clone(a.Skills), func(id string) bool { return !kept[id] })
	}
	return stored{Agents: agents, Skills: skills, Settings: s.Settings}
}

func New(home string) (*Service, error) {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return nil, err
	}
	file := filepath.Join(home, "config.json")
	st := &Service{Home: home, disk: base.NewFileWriter(file, 0o644)}
	seed := stored{Agents: protocol.SeedAgents(), Skills: []protocol.Skill{}, Settings: map[string]protocol.RuntimeSettings{}}
	body, err := os.ReadFile(file)
	switch {
	case err == nil:
		if err := json.Unmarshal(body, &st.s); err != nil {
			// An unreadable file is kept aside, never overwritten: one that cannot be moved stops the start.
			aside := fmt.Sprintf("%s.unreadable-%d", file, time.Now().UnixMilli())
			if err := os.Rename(file, aside); err != nil {
				return nil, fmt.Errorf("%s cannot be read, and could not be kept aside as %s: %w", file, aside, err)
			}
			log.Printf("vibevalley: %s could not be read (%v): kept as %s, the profiles start from the seeds", file, err, aside)
			st.s = seed
		}
	default:
		st.s = seed
	}
	if st.s.Settings == nil {
		st.s.Settings = map[string]protocol.RuntimeSettings{}
	}
	st.s = withoutExamples(st.s)
	for i, a := range st.s.Agents {
		st.s.Agents[i] = withCast(a)
	}
	if !slices.ContainsFunc(st.s.Agents, func(a protocol.Agent) bool { return a.ID == protocol.ManagerAgent }) {
		st.s.Agents = append(st.s.Agents, withCast(managerProfile()))
	}
	return st, st.persist()
}

// The manager is a profile every farm has: built in, never deleted, on VibeValley's own agent (it runs no other).
func managerProfile() protocol.Agent {
	return protocol.Agent{
		ID: protocol.ManagerAgent, Name: "管家", Role: "替主人派活、转告结果", Enabled: true, Runtime: managerRuntime,
		PersonaMode: protocol.PersonaModeAppend, Skills: []string{}, MCPServers: []protocol.MCPServer{}, DisallowedTools: []string{},
		Env: map[string]string{}, Tags: []string{},
	}
}

// The runtime id of VibeValley's own agent, the one the manager runs on.
const managerRuntime = "vibevalley"

func (st *Service) persist() error {
	return st.disk.Write(func() ([]byte, error) {
		st.mu.Lock()
		defer st.mu.Unlock()
		return json.Marshal(st.s)
	})
}

func (st *Service) change(f func(*stored)) error {
	st.mu.Lock()
	f(&st.s)
	st.mu.Unlock()
	return st.persist()
}

// Agents are the profiles work is sent to: every one but the manager's.
func (st *Service) Agents() []protocol.Agent {
	return slices.DeleteFunc(st.All(), func(a protocol.Agent) bool { return a.ID == protocol.ManagerAgent })
}

// All the profiles, the manager's too.
func (st *Service) All() []protocol.Agent {
	st.mu.Lock()
	defer st.mu.Unlock()
	return slices.Clone(st.s.Agents)
}

// Agent is any profile by id, the manager's too.
func (st *Service) Agent(id string) *protocol.Agent {
	for _, a := range st.All() {
		if a.ID == id {
			return &a
		}
	}
	return nil
}

func (st *Service) Skills() []protocol.Skill {
	st.mu.Lock()
	defer st.mu.Unlock()
	return slices.Clone(st.s.Skills)
}

func (st *Service) Settings(runtime string) protocol.RuntimeSettings {
	st.mu.Lock()
	defer st.mu.Unlock()
	if s, ok := st.s.Settings[runtime]; ok {
		return s
	}
	return protocol.DefaultSettings()
}

func upsert[T any](list []T, item T, id func(T) string) []T {
	out := slices.Clone(list)
	if i := slices.IndexFunc(out, func(x T) bool { return id(x) == id(item) }); i >= 0 {
		out[i] = item
		return out
	}
	return append(out, item)
}

func (st *Service) SaveAgent(agent protocol.Agent) (protocol.Agent, error) {
	if agent.ID == protocol.ManagerAgent && agent.Runtime != managerRuntime {
		return agent, errors.New("管家只在 VibeValley 自己的 agent 上跑：农机留着 " + managerRuntime)
	}
	agent = withCast(agent)
	return agent, st.change(func(s *stored) {
		s.Agents = upsert(s.Agents, agent, func(a protocol.Agent) string { return a.ID })
	})
}

func (st *Service) DeleteAgent(id string) error {
	if id == protocol.ManagerAgent {
		return protocol.Refused{Reason: "管家是每个农场都有的，删不了"}
	}
	return st.change(func(s *stored) {
		s.Agents = slices.DeleteFunc(slices.Clone(s.Agents), func(a protocol.Agent) bool { return a.ID == id })
	})
}

func (st *Service) SaveSkill(skill protocol.Skill) (protocol.Skill, error) {
	return skill, st.change(func(s *stored) { s.Skills = upsert(s.Skills, skill, func(k protocol.Skill) string { return k.ID }) })
}

func (st *Service) DeleteSkill(id string) error {
	return st.change(func(s *stored) {
		s.Skills = slices.DeleteFunc(slices.Clone(s.Skills), func(k protocol.Skill) bool { return k.ID == id })
	})
}

func (st *Service) SaveSettings(runtime string, settings protocol.RuntimeSettings) (protocol.RuntimeSettings, error) {
	return settings, st.change(func(s *stored) {
		next := make(map[string]protocol.RuntimeSettings, len(s.Settings)+1)
		for k, v := range s.Settings {
			next[k] = v
		}
		next[runtime] = settings
		s.Settings = next
	})
}
