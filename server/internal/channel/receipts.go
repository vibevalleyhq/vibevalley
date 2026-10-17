package channel

import "vibevalley/pkg/x/clock"

// A read cursor subsumes individual seen marks and completes the same deliveries.
func (c *Service) readThrough(who, conversation string, upto int64) error {
	return c.inTx(func(s chatStore) error {
		if err := s.setReadCursor(who, conversation, upto, clock.NowMs()); err != nil {
			return err
		}
		if err := s.pruneSeenMarks(who, conversation, upto); err != nil {
			return err
		}
		return s.seenUpTo(who, conversation, upto, clock.NowMs())
	})
}

// Speaking acknowledges the launch's handed messages without advancing past unseen messages.
func (c *Service) heardLaunch(who, launch string) error {
	return c.inTx(func(s chatStore) error {
		seen, err := s.seenHanded(who, launch, clock.NowMs())
		if err != nil {
			return err
		}
		for _, id := range seen {
			if err := s.addSeenMark(who, id); err != nil {
				return err
			}
		}
		return nil
	})
}
