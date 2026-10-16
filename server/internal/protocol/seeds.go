package protocol

import (
	_ "embed"
	"encoding/json"
)

//go:embed seeds.json
var seedsJSON []byte

type RuntimePreset struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Blurb string `json:"blurb"`
	Look  Look   `json:"look"`
}

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

// A copy each call.
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

// A runtime with no look of its own gets the fallback's, under its own id.
func PresetOf(runtime string) RuntimePreset {
	for _, p := range seeds.RuntimePresets {
		if p.ID == runtime {
			return p
		}
	}
	return RuntimePreset{ID: runtime, Label: runtime, Blurb: "VibeValley 还没有专属外形的 runtime。", Look: Look{Build: BuildBiped, Head: HeadRounded, Body: "#f1e8d8", Trim: "#5d5850", Hat: "#f2b53a", Eye: "#a6f4ff"}}
}

func RuntimeLabel(runtime string) string { return PresetOf(runtime).Label }

func RuntimeIDs() []string { return append([]string(nil), seeds.RuntimeIDs...) }

func FactsOf(runtime string) RuntimeFacts {
	if f, ok := seeds.RuntimeFacts[runtime]; ok {
		return f
	}
	return RuntimeFacts{Refused: map[string]string{}}
}

func CanSteer(runtime string) bool { return FactsOf(runtime).Steer }
