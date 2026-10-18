package schedule

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/agent"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/db/generated"
	"vibevalley/pkg/x/clock"
)

// A run missed while the server was off happens once at the first tick, and says it is late.

type chatView interface {
	Channels() []channel.Info
	General() string
	Notice(conversation string, text, code string)
	ChannelOf(conversation string) channel.Info
}

// $TZ, else where /etc/localtime points, else the offset now.
func localZone() string {
	if tz := os.Getenv("TZ"); tz != "" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if target, err := filepath.EvalSymlinks("/etc/localtime"); err == nil {
		if i := strings.Index(target, "zoneinfo/"); i >= 0 {
			name := target[i+len("zoneinfo/"):]
			if _, err := time.LoadLocation(name); err == nil {
				return name
			}
		}
	}
	_, offset := time.Now().Zone()
	sign := "+"
	if offset < 0 {
		sign, offset = "-", -offset
	}
	return fmt.Sprintf("%s%02d:%02d", sign, offset/3600, offset/60%60)
}

func tickEvery(ms float64) time.Duration {
	if ms <= 0 {
		return 0
	}
	return time.Duration(ms * float64(time.Millisecond))
}

type Service struct {
	q     *generated.Queries
	core  *core.Service
	store *agent.Service
	// The ticker, the tools and the pages all change the list.
	mu    sync.Mutex
	due   *base.Hub[Due]
	every time.Duration
	Now   func() int64
	chat  chatView
}

func newService(cfg base.Config, db *sql.DB, core *core.Service, store *agent.Service, chat *channel.Service) (*Service, error) {
	s := &Service{
		q: generated.New(db), core: core, store: store, chat: chat, due: base.NewHub[Due](), Now: clock.NowMs,
		every: tickEvery(cfg.Schedule.TickMs),
	}
	rows, err := s.q.Schedules(context.Background())
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		sc := protocol.Schedule{ID: row.ID, Name: row.Name, Text: row.Body, Channel: row.ChannelID, TZ: row.Tz, Created: row.CreatedAt}
		agent, project, spec, enabled, lastRun := row.Agent, row.Project, row.Spec, row.Enabled, row.LastRun
		// A schedule whose time this code cannot read any more is left out.
		if json.Unmarshal([]byte(spec), &sc.When) != nil || sc.When.Value == nil {
			continue
		}
		if agent.Valid && agent.String != "" {
			sc.Agent = &agent.String
		}
		if project.Valid && project.String != "" {
			sc.Project = &project.String
		}
		sc.Enabled, sc.By, sc.Pending = enabled, protocol.ScheduleBy(row.By), row.Pending
		if lastRun.Valid && lastRun.Int64 != 0 {
			sc.LastRun = &lastRun.Int64
		}
		core.Apply(protocol.FactSchedule{Schedule: sc})
	}
	return s, nil
}

func (*Service) OnStart(context.Context) error { return nil }

// After every service has started, so what a first tick finds due reaches the manager, which subscribes in its own start.
func (s *Service) OnReady(ctx context.Context) {
	go func() {
		s.Tick()
		every := time.NewTicker(max(s.every, time.Millisecond))
		defer every.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-every.C:
				s.Tick()
			}
		}
	}()
}

func (*Service) OnStop() {}

func (s *Service) find(id string) (protocol.Schedule, error) {
	all := s.core.State().Schedules
	if i := slices.IndexFunc(all, func(x protocol.Schedule) bool { return x.ID == id }); i >= 0 {
		return all[i], nil
	}
	return protocol.Schedule{}, fmt.Errorf("没有 %s 号定时", id)
}

func (s *Service) List() []protocol.Schedule {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.core.State().Schedules)
}

// by is who asks; ownerInRun, for the manager, whether the owner's words are in the run it asks from (needsOK).
func (s *Service) Add(req protocol.ScheduleRequest, by protocol.ScheduleBy, ownerInRun bool) (protocol.Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	if problem := protocol.ScheduleProblem(req, now); problem != "" {
		return protocol.Schedule{}, errors.New(problem)
	}
	chat := s.chat
	want := chat.General()
	if req.Channel != nil {
		want = *req.Channel
	}
	i := slices.IndexFunc(chat.Channels(), func(c channel.Info) bool { return c.ID == want })
	if i < 0 {
		return protocol.Schedule{}, fmt.Errorf("没有 %s 这个频道", want)
	}
	channel := chat.Channels()[i]
	var agent *protocol.Agent
	named := ""
	if req.Agent != nil {
		named = strings.TrimSpace(*req.Agent)
	}
	if named != "" {
		agents := s.store.Agents()
		if j := slices.IndexFunc(agents, func(a protocol.Agent) bool { return a.ID == named }); j >= 0 {
			agent = &agents[j]
		} else if j := slices.IndexFunc(agents, func(a protocol.Agent) bool { return a.Name == named }); j >= 0 {
			agent = &agents[j]
		}
		if agent == nil {
			return protocol.Schedule{}, fmt.Errorf("没有叫 %s 的帮工档案", *req.Agent)
		}
	}
	project := ""
	if req.Project != nil {
		project = strings.TrimSpace(*req.Project)
	}
	if agent != nil && project == "" && channel.Project == "" {
		return protocol.Schedule{}, fmt.Errorf("#%s 没有默认项目：直接派给帮工的定时要写 project", channel.Name)
	}
	tz := localZone()
	if req.TZ != nil {
		tz = *req.TZ
	}
	spec, err := json.Marshal(req.When)
	if err != nil {
		return protocol.Schedule{}, err
	}
	pending := needsOK(req, by, ownerInRun)
	sc := protocol.Schedule{
		Name: strings.TrimSpace(req.Name), Text: strings.TrimSpace(req.Text), Channel: channel.ID, When: req.When, TZ: tz,
		// Counted from now, by the same clock that ticks.
		Enabled: !pending, Created: now, By: by, Pending: pending,
	}
	sc.ID = base.NewID()
	row := generated.AddScheduleParams{
		ID: sc.ID, Name: sc.Name, Body: sc.Text, ChannelID: sc.Channel, Spec: string(spec), Tz: tz, By: string(by), Pending: pending, CreatedAt: now,
	}
	if agent != nil {
		id := agent.ID
		sc.Agent, row.Agent = &id, sql.NullString{String: id, Valid: true}
	}
	if project != "" {
		sc.Project, row.Project = &project, sql.NullString{String: project, Valid: true}
	}
	if err := s.q.AddSchedule(context.Background(), row); err != nil {
		return protocol.Schedule{}, err
	}
	s.core.Apply(protocol.FactSchedule{Schedule: sc})
	return sc, nil
}

func (s *Service) ran(id string, at int64, enabled bool) error {
	return s.q.ScheduleRan(context.Background(), generated.ScheduleRanParams{LastRun: sql.NullInt64{Int64: at, Valid: true}, Enabled: enabled, ID: id})
}

func (s *Service) SetEnabled(id string, enabled bool) (protocol.Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	was, err := s.find(id)
	if err != nil {
		return protocol.Schedule{}, err
	}
	sc := was
	// Turned on is the owner's yes (only the owner may: schedule.update); the queries clear pending the same way.
	sc.Enabled, sc.Pending = enabled, was.Pending && !enabled
	// Switched back on: it counts from now, not from runs it skipped while off.
	if _, once := was.When.Value.(protocol.ScheduleWhenOnce); enabled && !was.Enabled && !once {
		now := s.Now()
		sc.LastRun = &now
		if err := s.ran(id, now, enabled); err != nil {
			return protocol.Schedule{}, err
		}
	} else if err := s.q.EnableSchedule(context.Background(), generated.EnableScheduleParams{Enabled: enabled, ID: id}); err != nil {
		return protocol.Schedule{}, err
	}
	s.core.Apply(protocol.FactSchedule{Schedule: sc})
	return sc, nil
}

func (s *Service) Remove(id string) (protocol.Schedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	was, err := s.find(id)
	if err != nil {
		return protocol.Schedule{}, err
	}
	if err := s.q.RemoveSchedule(context.Background(), id); err != nil {
		return protocol.Schedule{}, err
	}
	s.core.Apply(protocol.FactUnschedule{ID: id})
	return was, nil
}

func (s *Service) Tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	for _, sc := range dueSchedules(s.core.State().Schedules, now) {
		missed := isMissed(sc, now)
		after := afterRun(sc, now)
		if err := s.ran(after.ID, now, after.Enabled); err != nil {
			log.Printf("vibevalley: schedule %s's run was not kept: %v", sc.ID, err)
			continue
		}
		s.core.Apply(protocol.FactSchedule{Schedule: after})
		s.chat.Notice(sc.Channel, protocol.DueText(sc, missed), "schedule")
		s.due.Publish(Due{Schedule: after, Missed: missed})
	}
}

func (s *Service) Due() *base.Hub[Due] { return s.due }
