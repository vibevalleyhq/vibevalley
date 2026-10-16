package tickets

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/chat"
	"vibevalley/internal/protocol"
)

// Schedules (ported from the TypeScript server's schedules.ts, removed): things said in a channel at set times. They are kept in the schedules
// table and mirrored into the core state as schedule facts, so every page lists them. Every tick, the ones due are
// said in their channel as a notice everyone sees, then handed on (Due) for the manager to act on, or to send a helper
// straight off. A run missed while the server was off happens once at the first tick, and says it is late. The rules
// (when next, what can be asked) are protocol's schedules.go.

// planChat is what schedules and the heartbeat ask of the chat: Chat on the farm, a stand-in in tests.
type planChat interface {
	Channels() []base.ChannelInfo
	Square() int64
	Notice(conversation int64, text, code string)
	ChannelOf(conversation int64) base.ChannelInfo
}

// planLocalZone is the machine's time zone as an IANA name (Intl's resolvedOptions().timeZone): $TZ, else where
// /etc/localtime points, else the offset now.
func planLocalZone() string {
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

// planEnvNumber is JavaScript's Number(process.env[name] ?? def): def when unset, 0 when set but blank, NaN when
// it is not a number.
func planEnvNumber(name string, def float64) float64 {
	v, ok := os.LookupEnv(name)
	if !ok {
		return def
	}
	t := strings.TrimSpace(v)
	if t == "" {
		return 0
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return n
}

// planTickEvery is how often schedules tick: $VIBEVALLEY_SCHEDULE_TICK_MS, 20 s when unset or not a number.
func planTickEvery() time.Duration {
	ms := planEnvNumber("VIBEVALLEY_SCHEDULE_TICK_MS", 20_000)
	if math.IsNaN(ms) || ms < 0 {
		return 20 * time.Second
	}
	return time.Duration(ms * float64(time.Millisecond))
}

// planHeartbeatEvery is how often the heartbeat looks: $VIBEVALLEY_HEARTBEAT_MINUTES (10); 0, blank or not a number
// turns it off, as the TypeScript server's minutes > 0 did.
func planHeartbeatEvery() time.Duration {
	minutes := planEnvNumber("VIBEVALLEY_HEARTBEAT_MINUTES", 10)
	if !(minutes > 0) {
		return 0
	}
	return time.Duration(minutes * float64(time.Minute))
}

type Schedules struct {
	db    *sql.DB
	site  *base.Site
	store *base.Store
	// mu: one change at a time; the ticker, the tools and the pages all change the list.
	mu  sync.Mutex
	all []protocol.FarmSchedule
	due *base.Hub[base.Due]
	// every is how often it ticks ($VIBEVALLEY_SCHEDULE_TICK_MS, 20 s).
	every time.Duration
	// Now is the clock and chat the chat; tests change them.
	Now  func() int64
	chat planChat
}

func newSchedules(db *sql.DB, site *base.Site, store *base.Store, chat *chat.Chat) (*Schedules, error) {
	s := &Schedules{
		db: db, site: site, store: store, chat: chat, due: base.NewHub[base.Due](), Now: base.NowMs,
		every: planTickEvery(),
	}
	rows, err := db.Query("select id, name, body, channel_id, agent, project, spec, tz, enabled, created_at, last_run from schedules order by id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sc protocol.FarmSchedule
		var agent, project sql.NullString
		var spec string
		var enabled int64
		var lastRun sql.NullInt64
		if err := rows.Scan(&sc.ID, &sc.Name, &sc.Text, &sc.Channel, &agent, &project, &spec, &sc.TZ, &enabled, &sc.Created, &lastRun); err != nil {
			return nil, err
		}
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
		sc.Enabled = enabled != 0
		if lastRun.Valid && lastRun.Int64 != 0 {
			sc.LastRun = &lastRun.Int64
		}
		s.all = append(s.all, sc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, sc := range s.all {
		site.Apply(protocol.FactSchedule{Schedule: sc})
	}
	return s, nil
}

// start ticks: the first a moment after start (what was missed while the server was off), then every so often.
func (*Schedules) OnStart(context.Context) error { return nil }

// ready starts the ticks once every service has started, so what a first tick finds due (a run missed while the farm
// was off) reaches the manager, which subscribes in its own start.
func (s *Schedules) OnReady(ctx context.Context) {
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

func (*Schedules) OnStop() {}

// put is a schedule changed or added, in the list and the core state. Called with mu held.
func (s *Schedules) put(sc protocol.FarmSchedule) {
	if i := slices.IndexFunc(s.all, func(x protocol.FarmSchedule) bool { return x.ID == sc.ID }); i >= 0 {
		s.all = slices.Clone(s.all)
		s.all[i] = sc
	} else {
		s.all = append(slices.Clip(s.all), sc)
	}
	s.site.Apply(protocol.FactSchedule{Schedule: sc})
}

func (s *Schedules) find(id int64) (protocol.FarmSchedule, error) {
	if i := slices.IndexFunc(s.all, func(x protocol.FarmSchedule) bool { return x.ID == id }); i >= 0 {
		return s.all[i], nil
	}
	return protocol.FarmSchedule{}, fmt.Errorf("没有 %d 号定时", id)
}

func (s *Schedules) List() []protocol.FarmSchedule {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.all)
}

// Add makes one; the channel defaults to 田头, the agent is a profile's id or name, the time zone the machine's.
func (s *Schedules) Add(req protocol.ScheduleRequest) (protocol.FarmSchedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	if problem := protocol.ScheduleProblem(req, now); problem != "" {
		return protocol.FarmSchedule{}, errors.New(problem)
	}
	chat := s.chat
	want := chat.Square()
	if req.Channel != nil {
		want = *req.Channel
	}
	i := slices.IndexFunc(chat.Channels(), func(c base.ChannelInfo) bool { return c.ID == want })
	if i < 0 {
		return protocol.FarmSchedule{}, fmt.Errorf("没有 %d 这个频道", want)
	}
	channel := chat.Channels()[i]
	var agent *protocol.AgentProfile
	named := ""
	if req.Agent != nil {
		named = strings.TrimSpace(*req.Agent)
	}
	if named != "" {
		agents := s.store.Agents()
		if j := slices.IndexFunc(agents, func(a protocol.AgentProfile) bool { return a.ID == named }); j >= 0 {
			agent = &agents[j]
		} else if j := slices.IndexFunc(agents, func(a protocol.AgentProfile) bool { return a.Name == named }); j >= 0 {
			agent = &agents[j]
		}
		if agent == nil {
			return protocol.FarmSchedule{}, fmt.Errorf("没有叫 %s 的帮工档案", *req.Agent)
		}
	}
	project := ""
	if req.Project != nil {
		project = strings.TrimSpace(*req.Project)
	}
	if agent != nil && project == "" && channel.Project == "" {
		return protocol.FarmSchedule{}, fmt.Errorf("#%s 没有默认项目：直接派给帮工的定时要写 project", channel.Name)
	}
	tz := planLocalZone()
	if req.TZ != nil {
		tz = *req.TZ
	}
	spec, err := json.Marshal(req.When)
	if err != nil {
		return protocol.FarmSchedule{}, err
	}
	sc := protocol.FarmSchedule{
		Name: strings.TrimSpace(req.Name), Text: strings.TrimSpace(req.Text), Channel: channel.ID, When: req.When, TZ: tz,
		// Counted from now, by the same clock that ticks.
		Enabled: true, Created: now,
	}
	var agentID, projectCol any
	if agent != nil {
		id := agent.ID
		sc.Agent, agentID = &id, id
	}
	if project != "" {
		sc.Project, projectCol = &project, project
	}
	res, err := s.db.Exec(
		"insert into schedules (name, body, channel_id, agent, project, spec, tz, enabled, created_at) values (?, ?, ?, ?, ?, ?, ?, 1, ?)",
		sc.Name, sc.Text, sc.Channel, agentID, projectCol, string(spec), tz, now,
	)
	if err != nil {
		return protocol.FarmSchedule{}, err
	}
	if sc.ID, err = res.LastInsertId(); err != nil {
		return protocol.FarmSchedule{}, err
	}
	s.put(sc)
	return sc, nil
}

func (s *Schedules) ran(id, at int64, enabled bool) error {
	_, err := s.db.Exec("update schedules set last_run = ?, enabled = ? where id = ?", at, enabled, id)
	return err
}

func (s *Schedules) SetEnabled(id int64, enabled bool) (protocol.FarmSchedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	was, err := s.find(id)
	if err != nil {
		return protocol.FarmSchedule{}, err
	}
	if _, err := s.db.Exec("update schedules set enabled = ? where id = ?", enabled, id); err != nil {
		return protocol.FarmSchedule{}, err
	}
	sc := was
	sc.Enabled = enabled
	// Switched back on: it counts from now, not from runs it skipped while off.
	if _, once := was.When.Value.(protocol.ScheduleWhenOnce); enabled && !was.Enabled && !once {
		now := s.Now()
		sc.LastRun = &now
		if err := s.ran(id, now, enabled); err != nil {
			return protocol.FarmSchedule{}, err
		}
	}
	s.put(sc)
	return sc, nil
}

func (s *Schedules) Remove(id int64) (protocol.FarmSchedule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	was, err := s.find(id)
	if err != nil {
		return protocol.FarmSchedule{}, err
	}
	if _, err := s.db.Exec("delete from schedules where id = ?", id); err != nil {
		return protocol.FarmSchedule{}, err
	}
	s.all = slices.DeleteFunc(slices.Clone(s.all), func(x protocol.FarmSchedule) bool { return x.ID == id })
	s.site.Apply(protocol.FactUnschedule{ID: id})
	return was, nil
}

// Tick runs what is due now: each said in its channel, then handed on. The ticker calls it.
func (s *Schedules) Tick() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	for _, sc := range protocol.DueSchedules(s.all, now) {
		missed := protocol.IsMissed(sc, now)
		after := protocol.AfterRun(sc, now)
		if err := s.ran(after.ID, now, after.Enabled); err != nil {
			log.Printf("vibevalley: schedule %d's run was not kept: %v", sc.ID, err)
		}
		s.put(after)
		s.chat.Notice(sc.Channel, protocol.DueText(sc, missed), "schedule")
		s.due.Publish(base.Due{Schedule: after, Missed: missed})
	}
}

// Due is the schedules as they come due, after each one's notice is in its channel.
func (s *Schedules) Due() *base.Hub[base.Due] { return s.due }

// Heartbeat: every $VIBEVALLEY_HEARTBEAT_MINUTES (10; 0 turns it off) the farm looks over its inbox without a model
// (protocol.PatrolStep): what has waited there past its grace and was not reported lately is news, once per channel,
// for the manager. A round costs nothing; a wake is a run.
type Heartbeat struct {
	site   *base.Site
	mu     sync.Mutex
	memory protocol.PatrolMemory
	news   *base.Hub[base.PatrolNews]
	every  time.Duration
	// Now is the clock and chat the chat; tests change them.
	Now  func() int64
	chat planChat
}

func newHeartbeat(site *base.Site, chat *chat.Chat) (*Heartbeat, error) {
	return &Heartbeat{
		site: site, chat: chat, memory: protocol.EmptyPatrol(), news: base.NewHub[base.PatrolNews](), Now: base.NowMs,
		every: planHeartbeatEvery(),
	}, nil
}

// start: the first round waits one interval, since right after a start what looks hanging is mostly the restart.
func (h *Heartbeat) OnStart(ctx context.Context) error {
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
				h.Round()
			}
		}
	}()
	return nil
}

func (*Heartbeat) OnStop() {}

// Round looks over the farm once now.
func (h *Heartbeat) Round() {
	h.mu.Lock()
	defer h.mu.Unlock()
	chat := h.chat
	report, memory := protocol.PatrolStep(h.site.State(), h.Now(), h.memory)
	h.memory = memory
	var order []int64
	byChannel := map[int64][]protocol.PatrolNote{}
	for _, f := range report {
		channel := chat.Square()
		if f.Channel != nil {
			channel = *f.Channel
		}
		if _, ok := byChannel[channel]; !ok {
			order = append(order, channel)
		}
		byChannel[channel] = append(byChannel[channel], f)
	}
	for _, channel := range order {
		h.news.Publish(base.PatrolNews{Channel: channel, Text: protocol.PatrolText(chat.ChannelOf(channel).Name, byChannel[channel])})
	}
}

func (h *Heartbeat) News() *base.Hub[base.PatrolNews] { return h.news }
