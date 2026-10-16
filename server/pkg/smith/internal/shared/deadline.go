package shared

import (
	"errors"
	"time"
)

// Remaining is what is left of a budget that ends at deadline. None left is
// a timeout, an error: "<name> timed out" (shared/deadline.ts).
func Remaining(deadline time.Time, name string) (time.Duration, error) {
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return 0, errors.New(name + " timed out")
	}
	return remaining, nil
}
