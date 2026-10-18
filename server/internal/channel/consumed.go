package channel

import (
	"log"

	"vibevalley/internal/session"
	"vibevalley/pkg/x/clock"
)

// Reading a digest only proposes context; the execution acknowledges actual consumption.
func (c *Service) consumedInput(input session.InputConsumed) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range input.Messages {
		if err := c.store().seenOne(input.Session, id, clock.NowMs()); err != nil {
			log.Printf("chat: consumed input %s for %s: %v", id, input.Session, err)
		}
	}
}
