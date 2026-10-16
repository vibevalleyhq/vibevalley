package shared

import (
	"time"

	"vibevalley/pkg/smith/oar"
)

// UtcInstantFromDate serializes a time as the public UTC-instant
// representation (Date.toISOString). A Go time is always valid, so unlike
// the TS helper (shared/instant.ts) there is no null answer.
func UtcInstantFromDate(value time.Time) string {
	return oar.UtcInstantFromTime(value)
}
