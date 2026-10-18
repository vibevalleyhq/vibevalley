package runtime

import (
	"maps"
	"slices"

	"vibevalley/internal/protocol"
)

// What the runtime takes: seeds.json's facts, with what it refuses taken from the adapter and the farm's policy laid over
// it.
func (r *Service) facts(id string) protocol.RuntimeFacts {
	facts := protocol.FactsOf(id)
	facts.Capabilities = slices.Clone(facts.Capabilities)
	facts.Refused = r.refusals(id)
	return facts
}

func (r *Service) refusals(id string) map[string]string {
	out := map[string]string{}
	if r.Registry != nil {
		if adapter, ok := r.Registry.Get(id); ok {
			for option, reason := range adapter.RefusedSessionOptions {
				out[string(option)] = reason
			}
		}
	}
	// Farm policy and its localized explanations remain authoritative when stricter than the adapter.
	maps.Copy(out, protocol.FactsOf(id).Refused)
	return out
}
