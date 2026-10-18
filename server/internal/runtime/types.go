package runtime

import (
	"vibevalley/internal/protocol"
	"vibevalley/pkg/smith/oar"
)

// Per million tokens, in dollars.
type Price struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// One accepted probe owns both its display and the installation used by later usage reads.
type observation struct {
	Info  protocol.RuntimeInfo
	Found *oar.AvailableInstallation
	Read  uint64
}
