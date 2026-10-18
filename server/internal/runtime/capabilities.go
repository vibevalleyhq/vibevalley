package runtime

import (
	"maps"
	"vibevalley/internal/protocol"
)

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
