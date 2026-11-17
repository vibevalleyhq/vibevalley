package agent

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	ErrNotFound              = errors.New("agent: record not found")
	ErrInvalidArgument       = errors.New("agent: invalid argument")
	ErrProtectedOrchestrator = errors.New("agent: default orchestrator cannot be deleted or demoted")
	ErrBuiltInReadOnly       = errors.New("agent: built-in skill is read-only")
	ErrStoreClosed           = errors.New("agent: store is closed")
)

// Role fixes an agent profile's authority boundary.
type Role string

const (
	RoleOrchestrator Role = "orchestrator"
	RoleWorker       Role = "worker"
)

// PersonaMode controls whether Persona appends to or replaces system instructions.
type PersonaMode string

const (
	PersonaAppend  PersonaMode = "append"
	PersonaReplace PersonaMode = "replace"
)

// Clock provides timestamps for profile/skill mutations.
type Clock interface {
	NowMs() int64
}

type realClock struct{}

func (realClock) NowMs() int64 { return time.Now().UnixMilli() }

// Profile configures a named coding agent or orchestrator persona.
type Profile struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Role            Role              `json:"role"`
	Duty            string            `json:"duty,omitempty"`
	Tags            []string          `json:"tags,omitempty"`
	Runtime         string            `json:"runtime"`
	Model           string            `json:"model,omitempty"`
	Effort          string            `json:"effort,omitempty"`
	Persona         string            `json:"persona,omitempty"`
	PersonaMode     PersonaMode       `json:"personaMode,omitempty"`
	Skills          []string          `json:"skills,omitempty"`
	DisallowedTools []string          `json:"disallowedTools,omitempty"`
	Env             map[string]string `json:"env,omitempty"`
	UseWorktree     bool              `json:"useWorktree"`
	CreatedAtMs     int64             `json:"createdAtMs"`
	UpdatedAtMs     int64             `json:"updatedAtMs"`
}

// Skill is a reusable Markdown instruction module mountable into `.vibe/skills/`.
type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Content     string `json:"content"`
	BuiltIn     bool   `json:"builtIn"`
	ReadOnly    bool   `json:"readOnly"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

// Problem reports a preflight or option compatibility issue on a Profile.
type Problem struct {
	Field string `json:"field"`
	Level string `json:"level"` // error, warn
	Text  string `json:"text"`
}

// ResolvedOptions holds the effective model, effort, env, and warnings/errors before spawn.
type ResolvedOptions struct {
	Model        string            `json:"model"`
	MissingModel string            `json:"missingModel,omitempty"`
	Effort       string            `json:"effort,omitempty"`
	Env          map[string]string `json:"env,omitempty"`
	Problems     []Problem         `json:"problems,omitempty"`
}

// Option configures an agent Registry.
type Option func(*registryConfig)

type registryConfig struct {
	clock Clock
}

// WithClock overrides the clock used for timestamps.
func WithClock(clock Clock) Option {
	return func(c *registryConfig) {
		if clock != nil {
			c.clock = clock
		}
	}
}

type registryBackend interface {
	loadAll(ctx context.Context) (profiles []Profile, skills []Skill, runtimes []RuntimeInfo, err error)
	saveProfile(ctx context.Context, p Profile) error
	deleteProfile(ctx context.Context, id string) error
	saveSkill(ctx context.Context, s Skill) error
	deleteSkill(ctx context.Context, id string) error
	saveRuntime(ctx context.Context, r RuntimeInfo) error
	close() error
}

// Registry manages agent profiles, skills (built-in read-only + user custom),
// and runtime presets/settings/preflight resolution.
type Registry struct {
	backend registryBackend
	clock   Clock

	mu       sync.RWMutex
	profiles map[string]Profile
	skills   map[string]Skill
	runtimes map[string]RuntimeInfo

	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

var defaultBuiltinSkills = []Skill{
	{ID: "slides", Name: "Slides", Description: "Generate HTML presentation slides.", Content: "# Slides Skill\nBuild responsive HTML slide decks.", BuiltIn: true, ReadOnly: true},
	{ID: "collector", Name: "Collector", Description: "Gather and organize reference assets.", Content: "# Collector Skill\nCollect verified visual references into media storage.", BuiltIn: true, ReadOnly: true},
	{ID: "pages", Name: "Pages", Description: "Create single-page dashboards and reports.", Content: "# Pages Skill\nBuild self-contained interactive dashboards.", BuiltIn: true, ReadOnly: true},
	{ID: "reviewer", Name: "Reviewer", Description: "Read-only branch and PR code review.", Content: "# Reviewer Skill\nInspect diffs and verify acceptance criteria without editing.", BuiltIn: true, ReadOnly: true},
}

// NewMemoryRegistry creates an in-memory agent Registry seeded with defaults.
func NewMemoryRegistry(opts ...Option) *Registry {
	reg, _ := newRegistry(context.Background(), nil, opts...)
	return reg
}

// OpenSQLiteRegistry creates or reopens a SQLite WAL-backed agent Registry at path.
func OpenSQLiteRegistry(ctx context.Context, path string, opts ...Option) (*Registry, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	b, err := openSQLiteAgentBackend(ctx, path)
	if err != nil {
		return nil, err
	}
	return newRegistry(ctx, b, opts...)
}

// OpenSQLiteRegistryFromDB attaches an agent Registry to an already-migrated *sql.DB
// without running migrations or closing sqlDB on Close.
func OpenSQLiteRegistryFromDB(ctx context.Context, sqlDB *sql.DB, opts ...Option) (*Registry, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b, err := openSQLiteAgentFromDB(sqlDB)
	if err != nil {
		return nil, err
	}
	return newRegistry(ctx, b, opts...)
}

func newRegistry(ctx context.Context, b registryBackend, opts ...Option) (*Registry, error) {
	cfg := registryConfig{clock: realClock{}}
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	r := &Registry{
		backend:  b,
		clock:    cfg.clock,
		profiles: make(map[string]Profile),
		skills:   make(map[string]Skill),
		runtimes: make(map[string]RuntimeInfo),
	}
	if b != nil {
		profiles, skills, runtimes, err := b.loadAll(ctx)
		if err != nil {
			_ = b.close()
			return nil, err
		}
		for _, p := range profiles {
			r.profiles[p.ID] = cloneProfile(p)
		}
		for _, s := range skills {
			r.skills[s.ID] = s
		}
		for _, rt := range runtimes {
			r.runtimes[rt.ID] = cloneRuntime(rt)
		}
	}
	if err := r.seedDefaults(ctx); err != nil {
		_ = r.Close()
		return nil, err
	}
	return r, nil
}

func (r *Registry) seedDefaults(ctx context.Context) error {
	now := r.clock.NowMs()
	for _, sk := range defaultBuiltinSkills {
		sk.UpdatedAtMs = now
		r.skills[sk.ID] = sk
		if r.backend != nil {
			if err := r.backend.saveSkill(ctx, sk); err != nil {
				return err
			}
		}
	}
	for _, rtID := range KnownRuntimeIDs {
		if _, exists := r.runtimes[rtID]; !exists {
			rt := RuntimeInfo{
				ID:        rtID,
				Installed: rtID == "vibevalley" || rtID == "pi",
				Settings:  RuntimeSettings{Enabled: true, Env: map[string]string{}},
				Support:   SupportOf(rtID),
				Preset:    PresetOf(rtID),
			}
			r.runtimes[rtID] = rt
			if r.backend != nil {
				if err := r.backend.saveRuntime(ctx, rt); err != nil {
					return err
				}
			}
		}
	}
	if _, exists := r.profiles["orchestrator"]; !exists {
		orch := Profile{
			ID:          "orchestrator",
			Name:        "Orchestrator",
			Role:        RoleOrchestrator,
			Duty:        "Coordinate channels, triage issues, and dispatch workers.",
			Runtime:     "vibevalley",
			PersonaMode: PersonaAppend,
			CreatedAtMs: now,
			UpdatedAtMs: now,
		}
		r.profiles[orch.ID] = orch
		if r.backend != nil {
			if err := r.backend.saveProfile(ctx, orch); err != nil {
				return err
			}
		}
	}
	return nil
}

// Close releases any underlying storage resources.
func (r *Registry) Close() error {
	r.closeOnce.Do(func() {
		r.closed.Store(true)
		if r.backend != nil {
			r.closeErr = r.backend.close()
		}
	})
	return r.closeErr
}

// SaveProfile creates or updates an agent profile while protecting the default orchestrator invariants.
func (r *Registry) SaveProfile(ctx context.Context, p Profile) (Profile, error) {
	if r.closed.Load() {
		return Profile{}, ErrStoreClosed
	}
	if strings.TrimSpace(p.ID) == "" || strings.TrimSpace(p.Name) == "" {
		return Profile{}, fmt.Errorf("%w: id and name are required", ErrInvalidArgument)
	}
	if p.Role == "" {
		p.Role = RoleWorker
	}
	if p.Role != RoleOrchestrator && p.Role != RoleWorker {
		return Profile{}, fmt.Errorf("%w: invalid role %q", ErrInvalidArgument, p.Role)
	}
	if p.ID == "orchestrator" && p.Role != RoleOrchestrator {
		return Profile{}, ErrProtectedOrchestrator
	}
	if p.Role == RoleOrchestrator && p.Runtime == "" {
		p.Runtime = "vibevalley"
	}
	if p.Runtime == "" {
		p.Runtime = "pi"
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.clock.NowMs()
	if prev, ok := r.profiles[p.ID]; ok && p.CreatedAtMs == 0 {
		p.CreatedAtMs = prev.CreatedAtMs
	}
	if p.CreatedAtMs == 0 {
		p.CreatedAtMs = now
	}
	p.UpdatedAtMs = now
	cp := cloneProfile(p)
	if r.backend != nil {
		if err := r.backend.saveProfile(ctx, cp); err != nil {
			return Profile{}, err
		}
	}
	r.profiles[cp.ID] = cp
	return cloneProfile(cp), nil
}

// GetProfile retrieves a profile by ID.
func (r *Registry) GetProfile(_ context.Context, id string) (Profile, error) {
	if r.closed.Load() {
		return Profile{}, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.profiles[id]
	if !ok {
		return Profile{}, fmt.Errorf("%w: profile %q", ErrNotFound, id)
	}
	return cloneProfile(p), nil
}

// ListProfiles returns all profiles sorted by role (orchestrators first) then ID.
func (r *Registry) ListProfiles(_ context.Context) ([]Profile, error) {
	if r.closed.Load() {
		return nil, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Profile, 0, len(r.profiles))
	for _, p := range r.profiles {
		out = append(out, cloneProfile(p))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Role != out[j].Role {
			return out[i].Role == RoleOrchestrator
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// DeleteProfile deletes a non-orchestrator profile.
func (r *Registry) DeleteProfile(ctx context.Context, id string) error {
	if r.closed.Load() {
		return ErrStoreClosed
	}
	if id == "orchestrator" {
		return ErrProtectedOrchestrator
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.profiles[id]
	if !ok {
		return fmt.Errorf("%w: profile %q", ErrNotFound, id)
	}
	if p.Role == RoleOrchestrator {
		return ErrProtectedOrchestrator
	}
	if r.backend != nil {
		if err := r.backend.deleteProfile(ctx, id); err != nil {
			return err
		}
	}
	delete(r.profiles, id)
	return nil
}

// SaveSkill saves a user skill; built-in skills cannot be overwritten or created with colliding IDs.
func (r *Registry) SaveSkill(ctx context.Context, sk Skill) (Skill, error) {
	if r.closed.Load() {
		return Skill{}, ErrStoreClosed
	}
	if strings.TrimSpace(sk.ID) == "" || strings.TrimSpace(sk.Name) == "" {
		return Skill{}, fmt.Errorf("%w: skill id and name are required", ErrInvalidArgument)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.skills[sk.ID]; ok && existing.BuiltIn {
		return Skill{}, ErrBuiltInReadOnly
	}
	sk.BuiltIn = false
	sk.UpdatedAtMs = r.clock.NowMs()
	if r.backend != nil {
		if err := r.backend.saveSkill(ctx, sk); err != nil {
			return Skill{}, err
		}
	}
	r.skills[sk.ID] = sk
	return sk, nil
}

// GetSkill returns a skill by ID.
func (r *Registry) GetSkill(_ context.Context, id string) (Skill, error) {
	if r.closed.Load() {
		return Skill{}, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	sk, ok := r.skills[id]
	if !ok {
		return Skill{}, fmt.Errorf("%w: skill %q", ErrNotFound, id)
	}
	return sk, nil
}

// ListSkills returns built-in skills first, followed by custom skills sorted by ID.
func (r *Registry) ListSkills(_ context.Context) ([]Skill, error) {
	if r.closed.Load() {
		return nil, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Skill, 0, len(r.skills))
	for _, sk := range r.skills {
		out = append(out, sk)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].BuiltIn != out[j].BuiltIn {
			return out[i].BuiltIn
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// DeleteSkill removes a custom skill and strips its reference from all profiles atomically.
func (r *Registry) DeleteSkill(ctx context.Context, id string) error {
	if r.closed.Load() {
		return ErrStoreClosed
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	sk, ok := r.skills[id]
	if !ok {
		return fmt.Errorf("%w: skill %q", ErrNotFound, id)
	}
	if sk.BuiltIn {
		return ErrBuiltInReadOnly
	}
	for pid, prof := range r.profiles {
		if slices.Contains(prof.Skills, id) {
			filtered := make([]string, 0, len(prof.Skills))
			for _, sid := range prof.Skills {
				if sid != id {
					filtered = append(filtered, sid)
				}
			}
			prof.Skills = filtered
			prof.UpdatedAtMs = r.clock.NowMs()
			if r.backend != nil {
				if err := r.backend.saveProfile(ctx, prof); err != nil {
					return err
				}
			}
			r.profiles[pid] = prof
		}
	}
	if r.backend != nil {
		if err := r.backend.deleteSkill(ctx, id); err != nil {
			return err
		}
	}
	delete(r.skills, id)
	return nil
}

// MountFilesForProfile materializes a profile's referenced skills as read-only contract.MountFile entries.
func (r *Registry) MountFilesForProfile(_ context.Context, profileID string) ([]contract.MountFile, error) {
	if r.closed.Load() {
		return nil, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	prof, ok := r.profiles[profileID]
	if !ok {
		return nil, fmt.Errorf("%w: profile %q", ErrNotFound, profileID)
	}
	files := make([]contract.MountFile, 0, len(prof.Skills))
	for _, sid := range prof.Skills {
		sk, exists := r.skills[sid]
		if !exists {
			continue
		}
		data := []byte(sk.Content)
		sum := sha256.Sum256(data)
		files = append(files, contract.MountFile{
			RelPath:  sid + "/SKILL.md",
			Version:  sk.UpdatedAtMs,
			SHA256:   hex.EncodeToString(sum[:]),
			Content:  data,
			ReadOnly: true,
		})
	}
	return files, nil
}

// SetRuntimeInfo updates probed installation, model catalog, and settings for a runtime.
func (r *Registry) SetRuntimeInfo(ctx context.Context, info RuntimeInfo) (RuntimeInfo, error) {
	if r.closed.Load() {
		return RuntimeInfo{}, ErrStoreClosed
	}
	if strings.TrimSpace(info.ID) == "" {
		return RuntimeInfo{}, fmt.Errorf("%w: runtime id is required", ErrInvalidArgument)
	}
	if info.Preset.ID == "" {
		info.Preset = PresetOf(info.ID)
	}
	if len(info.Support.Capabilities) == 0 && len(info.Support.Refused) == 0 && !info.Support.Steer {
		info.Support = SupportOf(info.ID)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := cloneRuntime(info)
	if r.backend != nil {
		if err := r.backend.saveRuntime(ctx, cp); err != nil {
			return RuntimeInfo{}, err
		}
	}
	r.runtimes[cp.ID] = cp
	return cloneRuntime(cp), nil
}

// GetRuntimeInfo returns RuntimeInfo for runtimeID (synthesizing preset/support if unprobed).
func (r *Registry) GetRuntimeInfo(_ context.Context, runtimeID string) (RuntimeInfo, error) {
	if r.closed.Load() {
		return RuntimeInfo{}, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	if rt, ok := r.runtimes[runtimeID]; ok {
		return cloneRuntime(rt), nil
	}
	return RuntimeInfo{
		ID:       runtimeID,
		Settings: RuntimeSettings{Enabled: true, Env: map[string]string{}},
		Support:  SupportOf(runtimeID),
		Preset:   PresetOf(runtimeID),
	}, nil
}

// ListRuntimes returns all known runtimes in canonical UI order followed by custom ones.
func (r *Registry) ListRuntimes(_ context.Context) ([]RuntimeInfo, error) {
	if r.closed.Load() {
		return nil, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	seen := make(map[string]bool, len(r.runtimes))
	out := make([]RuntimeInfo, 0, len(r.runtimes))
	for _, id := range KnownRuntimeIDs {
		if rt, ok := r.runtimes[id]; ok {
			out = append(out, cloneRuntime(rt))
			seen[id] = true
		}
	}
	var extras []string
	for id := range r.runtimes {
		if !seen[id] {
			extras = append(extras, id)
		}
	}
	slices.Sort(extras)
	for _, id := range extras {
		out = append(out, cloneRuntime(r.runtimes[id]))
	}
	return out, nil
}

// ResolveOptions merges runtime defaults with profile overrides and checks runtime support constraints.
func (r *Registry) ResolveOptions(_ context.Context, profileID string) (ResolvedOptions, error) {
	if r.closed.Load() {
		return ResolvedOptions{}, ErrStoreClosed
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	prof, ok := r.profiles[profileID]
	if !ok {
		return ResolvedOptions{}, fmt.Errorf("%w: profile %q", ErrNotFound, profileID)
	}
	rt, hasRT := r.runtimes[prof.Runtime]
	if !hasRT {
		rt = RuntimeInfo{
			ID:       prof.Runtime,
			Settings: RuntimeSettings{Enabled: true},
			Support:  SupportOf(prof.Runtime),
			Preset:   PresetOf(prof.Runtime),
		}
	}

	var problems []Problem
	if !hasRT {
		problems = append(problems, Problem{Field: "runtime", Level: "error", Text: fmt.Sprintf("unknown runtime %q", prof.Runtime)})
	} else {
		if !rt.Installed {
			problems = append(problems, Problem{Field: "runtime", Level: "error", Text: fmt.Sprintf("runtime %q is not installed", prof.Runtime)})
		}
		if !rt.Settings.Enabled {
			problems = append(problems, Problem{Field: "runtime", Level: "error", Text: fmt.Sprintf("runtime %q is disabled", prof.Runtime)})
		}
		if rt.Settings.DailyBudget > 0 && rt.SpentToday >= rt.Settings.DailyBudget {
			problems = append(problems, Problem{Field: "runtime", Level: "error", Text: "daily runtime budget exhausted"})
		}
	}

	wantedModel := prof.Model
	if wantedModel == "" {
		wantedModel = rt.Settings.DefaultModel
	}
	missingModel := ""
	if wantedModel != "" && len(rt.Models) > 0 {
		found := false
		for _, m := range rt.Models {
			if m.ID == wantedModel {
				found = true
				break
			}
		}
		if !found {
			missingModel = wantedModel
			wantedModel = ""
			problems = append(problems, Problem{Field: "model", Level: "warn", Text: fmt.Sprintf("model %q not supported by %s; falling back to default", missingModel, prof.Runtime)})
		}
	}

	effort := prof.Effort
	if effort == "" {
		effort = rt.Settings.DefaultEffort
	}

	env := make(map[string]string)
	maps.Copy(env, rt.Settings.Env)
	maps.Copy(env, prof.Env)

	refused := rt.Support.Refused
	if strings.TrimSpace(prof.Persona) != "" {
		optName := "appendSystemPrompt"
		if prof.PersonaMode == PersonaReplace {
			optName = "systemPrompt"
		}
		if msg, bad := refused[optName]; bad {
			problems = append(problems, Problem{Field: "persona", Level: "error", Text: msg})
		}
	}
	if effort != "" {
		if msg, bad := refused["effort"]; bad {
			problems = append(problems, Problem{Field: "effort", Level: "error", Text: msg})
		} else if len(rt.Models) > 0 {
			for _, m := range rt.Models {
				if (wantedModel != "" && m.ID == wantedModel) || (wantedModel == "" && m.IsDefault) {
					if len(m.EffortLevels) > 0 && !slices.Contains(m.EffortLevels, effort) {
						problems = append(problems, Problem{Field: "effort", Level: "error", Text: fmt.Sprintf("effort %q unsupported by model %s", effort, m.ID)})
					}
					break
				}
			}
		}
	}
	if len(env) > 0 {
		if msg, bad := refused["env"]; bad {
			problems = append(problems, Problem{Field: "env", Level: "error", Text: msg})
		}
	}
	if len(prof.DisallowedTools) > 0 {
		if msg, bad := refused["disallowedTools"]; bad {
			problems = append(problems, Problem{Field: "disallowedTools", Level: "error", Text: msg})
		}
	}

	return ResolvedOptions{
		Model:        wantedModel,
		MissingModel: missingModel,
		Effort:       effort,
		Env:          env,
		Problems:     problems,
	}, nil
}

// ChooseWorker selects the best usable worker profile by:
// 1) exact named ID or Name, 2) usable worker matching named runtime, 3) picked ID, 4) highest tag overlap against brief.
func (r *Registry) ChooseWorker(_ context.Context, brief, named, picked string) (Profile, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var workers []Profile
	for _, p := range r.profiles {
		if p.Role == RoleWorker {
			workers = append(workers, p)
		}
	}
	sort.Slice(workers, func(i, j int) bool { return workers[i].ID < workers[j].ID })

	isUsable := func(p Profile) bool {
		rt, ok := r.runtimes[p.Runtime]
		return ok && rt.Installed && rt.Settings.Enabled && !(rt.Settings.DailyBudget > 0 && rt.SpentToday >= rt.Settings.DailyBudget)
	}

	if named != "" {
		for _, p := range workers {
			if p.ID == named || p.Name == named {
				return cloneProfile(p), true
			}
		}
		for _, p := range workers {
			if p.Runtime == named && isUsable(p) {
				return cloneProfile(p), true
			}
		}
	}
	if picked != "" {
		for _, p := range workers {
			if p.ID == picked {
				return cloneProfile(p), true
			}
		}
	}

	lowerBrief := strings.ToLower(brief)
	var best Profile
	bestScore := -1
	for _, p := range workers {
		if !isUsable(p) {
			continue
		}
		score := 0
		for _, tag := range p.Tags {
			if tag != "" && strings.Contains(lowerBrief, strings.ToLower(tag)) {
				score++
			}
		}
		if score > bestScore {
			best = p
			bestScore = score
		}
	}
	if bestScore < 0 {
		return Profile{}, false
	}
	return cloneProfile(best), true
}

func cloneProfile(p Profile) Profile {
	p.Tags = slices.Clone(p.Tags)
	p.Skills = slices.Clone(p.Skills)
	p.DisallowedTools = slices.Clone(p.DisallowedTools)
	p.Env = maps.Clone(p.Env)
	return p
}

func cloneRuntime(rt RuntimeInfo) RuntimeInfo {
	rt.Models = slices.Clone(rt.Models)
	for i := range rt.Models {
		rt.Models[i].EffortLevels = slices.Clone(rt.Models[i].EffortLevels)
	}
	rt.Settings.Env = maps.Clone(rt.Settings.Env)
	rt.Support.Capabilities = slices.Clone(rt.Support.Capabilities)
	rt.Support.Refused = maps.Clone(rt.Support.Refused)
	return rt
}
