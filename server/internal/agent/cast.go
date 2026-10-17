package agent

import "vibevalley/internal/protocol"

// A profile saved without an animal or outfit gets them here, once, on load or save: the animal picked from its id, the
// outfit the farmer's. It must pick what the client's castOf (app/lib/rules/looks.dart) picks for a profile it does not
// know, so a profile looks the same before and after it is filled.
func withCast(a protocol.Agent) protocol.Agent {
	if a.Look.Species == nil {
		species := protocol.SpeciesValues[castHash(a.ID)%uint32(len(protocol.SpeciesValues))]
		a.Look.Species = &species
	}
	if a.Look.Outfit == nil {
		outfit := protocol.OutfitFarmer
		a.Look.Outfit = &outfit
	}
	return a
}

// Over each code point's first UTF-16 unit, wrapping at 32 bits, as the client counts.
func castHash(s string) uint32 {
	var h uint32
	for _, r := range s {
		unit := uint32(r)
		if r > 0xFFFF {
			unit = 0xD800 + uint32((r-0x10000)>>10)
		}
		h = h*31 + unit
	}
	return h
}
