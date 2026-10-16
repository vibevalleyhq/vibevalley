package base

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"time"

	"vibevalley/internal/protocol"
)

type stored struct {
	Agents   []protocol.AgentProfile             `json:"agents"`
	Skills   []protocol.Skill                    `json:"skills"`
	Settings map[string]protocol.RuntimeSettings `json:"settings"`
}

type Store struct {
	Home string
	mu   sync.Mutex
	s    stored
	disk *FileWriter
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

func NewStore(home string) (*Store, error) {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return nil, err
	}
	file := filepath.Join(home, "config.json")
	st := &Store{Home: home, disk: NewFileWriter(file, 0o644)}
	seed := stored{Agents: protocol.SeedAgents(), Skills: []protocol.Skill{}, Settings: map[string]protocol.RuntimeSettings{}}
	body, err := os.ReadFile(file)
	switch {
	case err == nil:
		if err := json.Unmarshal(body, &st.s); err != nil {
			// An unreadable file is kept aside, not overwritten.
			_ = os.Rename(file, fmt.Sprintf("%s.unreadable-%d", file, time.Now().UnixMilli()))
			st.s = seed
		}
	default:
		st.s = seed
	}
	if st.s.Settings == nil {
		st.s.Settings = map[string]protocol.RuntimeSettings{}
	}
	st.s = withoutExamples(st.s)
	return st, st.persist()
}

func (st *Store) persist() error {
	return st.disk.Write(func() ([]byte, error) {
		st.mu.Lock()
		defer st.mu.Unlock()
		return json.Marshal(st.s)
	})
}

func (st *Store) change(f func(*stored)) error {
	st.mu.Lock()
	f(&st.s)
	st.mu.Unlock()
	return st.persist()
}

func (st *Store) Agents() []protocol.AgentProfile {
	st.mu.Lock()
	defer st.mu.Unlock()
	return slices.Clone(st.s.Agents)
}

func (st *Store) Agent(id string) *protocol.AgentProfile {
	for _, a := range st.Agents() {
		if a.ID == id {
			return &a
		}
	}
	return nil
}

func (st *Store) Skills() []protocol.Skill {
	st.mu.Lock()
	defer st.mu.Unlock()
	return slices.Clone(st.s.Skills)
}

func (st *Store) Settings(runtime string) protocol.RuntimeSettings {
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

func (st *Store) SaveAgent(agent protocol.AgentProfile) (protocol.AgentProfile, error) {
	return agent, st.change(func(s *stored) {
		s.Agents = upsert(s.Agents, agent, func(a protocol.AgentProfile) string { return a.ID })
	})
}

func (st *Store) DeleteAgent(id string) error {
	return st.change(func(s *stored) {
		s.Agents = slices.DeleteFunc(slices.Clone(s.Agents), func(a protocol.AgentProfile) bool { return a.ID == id })
	})
}

func (st *Store) SaveSkill(skill protocol.Skill) (protocol.Skill, error) {
	return skill, st.change(func(s *stored) { s.Skills = upsert(s.Skills, skill, func(k protocol.Skill) string { return k.ID }) })
}

func (st *Store) DeleteSkill(id string) error {
	return st.change(func(s *stored) {
		s.Skills = slices.DeleteFunc(slices.Clone(s.Skills), func(k protocol.Skill) bool { return k.ID == id })
	})
}

func (st *Store) SaveSettings(runtime string, settings protocol.RuntimeSettings) (protocol.RuntimeSettings, error) {
	return settings, st.change(func(s *stored) {
		next := make(map[string]protocol.RuntimeSettings, len(s.Settings)+1)
		for k, v := range s.Settings {
			next[k] = v
		}
		next[runtime] = settings
		s.Settings = next
	})
}
