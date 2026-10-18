package protocol

import (
	_ "embed"
	"encoding/json"
)

// The achievements, in the order the page shows them.
var Achievements []AchievementDef

//go:embed seeds.json
var seedsJSON []byte

var seeds struct {
	Agents          []Agent                  `json:"agents"`
	DefaultSettings RuntimeSettings          `json:"defaultSettings"`
	Achievements    []AchievementDef         `json:"achievements"`
	RuntimePresets  []RuntimePreset          `json:"runtimePresets"`
	FallbackPreset  RuntimePreset            `json:"fallbackPreset"`
	RuntimeFacts    map[string]RuntimeFacts  `json:"runtimeFacts"`
	RuntimeIDs      []string                 `json:"runtimeIds"`
	ActionText      map[SessionAction]string `json:"actionText"`
}

func init() {
	if err := json.Unmarshal(seedsJSON, &seeds); err != nil {
		panic("protocol: seeds.json: " + err.Error())
	}
	Achievements, ActionText = seeds.Achievements, seeds.ActionText
}

// A copy each call.
func SeedAgents() []Agent {
	var out []Agent
	body, _ := json.Marshal(seeds.Agents)
	_ = json.Unmarshal(body, &out)
	return out
}

func DefaultSettings() RuntimeSettings {
	s := seeds.DefaultSettings
	s.Env = map[string]string{}
	return s
}

// A runtime with no look of its own gets the fallback's, under its own id.
func PresetOf(runtime string) RuntimePreset {
	for _, p := range seeds.RuntimePresets {
		if p.ID == runtime {
			return p
		}
	}
	p := seeds.FallbackPreset
	p.ID, p.Label = runtime, runtime
	return p
}

func RuntimeLabel(runtime string) string { return PresetOf(runtime).Label }

func RuntimeIDs() []string { return append([]string(nil), seeds.RuntimeIDs...) }

func FactsOf(runtime string) RuntimeFacts {
	if f, ok := seeds.RuntimeFacts[runtime]; ok {
		return f
	}
	return RuntimeFacts{Refused: map[string]string{}}
}

//go:embed seed_catalog.json
var seedCatalogJSON []byte

var seedCatalog struct {
	Kinds []SeedKind `json:"kinds"`
}

func init() {
	if err := json.Unmarshal(seedCatalogJSON, &seedCatalog); err != nil {
		panic("protocol: seed_catalog.json: " + err.Error())
	}
}

// The common jobs on the sowing form, in its order, as written: Done still holds {test}, {lint} and {build}. A copy each call.
func SeedCatalog() []SeedKind {
	out := make([]SeedKind, len(seedCatalog.Kinds))
	for i, k := range seedCatalog.Kinds {
		out[i] = k
		out[i].Seeds = append([]Seed(nil), k.Seeds...)
	}
	return out
}
