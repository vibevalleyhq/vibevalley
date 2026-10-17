package manager

import (
	"context"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/pkg/x/clock"
)

// Patrol (巡查) looks over the Inbox for what has waited too long and wakes the manager once per channel; it puts nothing on the farm itself.

type PatrolNews struct {
	Channel string
	Text    string
}

func patrolEvery(minutes float64) time.Duration {
	if minutes <= 0 {
		return 0
	}
	return time.Duration(minutes * float64(time.Minute))
}

// Without a model: a round costs nothing; a wake is a run.
type patrol struct {
	core      *core.Service
	mu        sync.Mutex
	memory    patrolMemory
	news      *base.Hub[PatrolNews]
	every     time.Duration
	PatrolNow func() int64
	chat      *channel.Service
}

func newPatrol(cfg base.Config, core *core.Service, chat *channel.Service) (*patrol, error) {
	return &patrol{
		core: core, chat: chat, memory: emptyPatrol(), news: base.NewHub[PatrolNews](), PatrolNow: clock.NowMs,
		every: patrolEvery(cfg.Patrol.HeartbeatMinutes),
	}, nil
}

// The first round waits one interval: right after a start, what looks hanging is mostly the restart.
func (h *patrol) OnStart(ctx context.Context) error {
	if h.every <= 0 {
		return nil
	}
	go func() {
		t := time.NewTicker(h.every)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				h.Patrol()
			}
		}
	}()
	return nil
}

func (*patrol) OnStop() {}

func (h *patrol) Patrol() {
	h.mu.Lock()
	defer h.mu.Unlock()
	chat := h.chat
	report, memory := patrolStep(h.core.State(), h.PatrolNow(), h.memory)
	h.memory = memory
	var order []string
	byChannel := map[string][]patrolNote{}
	for _, f := range report {
		channel := chat.General()
		if f.Channel != nil {
			channel = *f.Channel
		}
		if _, ok := byChannel[channel]; !ok {
			order = append(order, channel)
		}
		byChannel[channel] = append(byChannel[channel], f)
	}
	for _, channel := range order {
		h.news.Publish(PatrolNews{Channel: channel, Text: patrolText(chat.ChannelOf(channel).Name, byChannel[channel])})
	}
}

func (h *patrol) News() *base.Hub[PatrolNews] { return h.news }
