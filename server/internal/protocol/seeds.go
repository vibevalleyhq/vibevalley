package protocol

// The data the server starts from, kept in seeds.json: the seed agents, the default runtime settings, the example
// skills, each runtime's look and facts.

import (
	_ "embed"
	"encoding/json"
)

//go:embed seeds.json
var seedsJSON []byte

// RuntimePreset is a runtime's name, blurb and the look a new agent on it starts with (seeds.ts).
type RuntimePreset struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Blurb string `json:"blurb"`
	Look  Look   `json:"look"`
}

// RuntimeFacts is what a runtime can and cannot do (index.ts RUNTIME_FACTS).
type RuntimeFacts struct {
	Steer        bool              `json:"steer"`
	Refused      map[string]string `json:"refused"`
	Capabilities []string          `json:"capabilities"`
	InProcess    bool              `json:"inProcess"`
}

var seeds struct {
	Agents          []AgentProfile          `json:"agents"`
	DefaultSettings RuntimeSettings         `json:"defaultSettings"`
	ExampleSkills   []Skill                 `json:"exampleSkills"`
	RuntimePresets  []RuntimePreset         `json:"runtimePresets"`
	RuntimeFacts    map[string]RuntimeFacts `json:"runtimeFacts"`
	RuntimeIDs      []string                `json:"runtimeIds"`
}

func init() {
	if err := json.Unmarshal(seedsJSON, &seeds); err != nil {
		panic("protocol: seeds.json: " + err.Error())
	}
}

// SeedAgents are the agents a fresh farm starts with (a copy each call).
func SeedAgents() []AgentProfile {
	var out []AgentProfile
	body, _ := json.Marshal(seeds.Agents)
	_ = json.Unmarshal(body, &out)
	return out
}

func DefaultSettings() RuntimeSettings {
	s := seeds.DefaultSettings
	s.Env = map[string]string{}
	return s
}

func ExampleSkills() []Skill { return append([]Skill(nil), seeds.ExampleSkills...) }

func RuntimePresets() []RuntimePreset { return append([]RuntimePreset(nil), seeds.RuntimePresets...) }

// PresetOf is a runtime's preset; one vibevalley has no look for gets the fallback's, under its own id.
func PresetOf(runtime string) RuntimePreset {
	for _, p := range seeds.RuntimePresets {
		if p.ID == runtime {
			return p
		}
	}
	return RuntimePreset{ID: runtime, Label: runtime, Blurb: "VibeValley 还没有专属外形的 runtime。", Look: Look{Build: BuildBiped, Head: HeadRounded, Body: "#f1e8d8", Trim: "#5d5850", Hat: "#f2b53a", Eye: "#a6f4ff"}}
}

func RuntimeLabel(runtime string) string { return PresetOf(runtime).Label }

// RuntimeIDs are the runtimes vibevalley knows, in the protocol's order.
func RuntimeIDs() []string { return append([]string(nil), seeds.RuntimeIDs...) }

func FactsOf(runtime string) RuntimeFacts {
	if f, ok := seeds.RuntimeFacts[runtime]; ok {
		return f
	}
	return RuntimeFacts{Refused: map[string]string{}}
}

func CanSteer(runtime string) bool { return FactsOf(runtime).Steer }
