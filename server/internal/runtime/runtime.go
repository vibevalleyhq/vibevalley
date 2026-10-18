package runtime

import (
	"context"
	"database/sql"

	"vibevalley/internal/base"

	// Probing runs a runtime's own commands, so results are cached.

	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/agent"
	vvagent "vibevalley/internal/agent/brain"
	"vibevalley/internal/agent/brain/oarruntime"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/internal/task/engine"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/smith/community/dsh"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/runtimes/defaults"
	"vibevalley/pkg/smith/runtimes/pi"
	"vibevalley/pkg/x/clock"
)

const (
	// Past this a probe counts as unknown.
	probeTimeout = 10 * time.Second
	usageEvery   = 5 * time.Minute
	// Several runs share one read.
	usageAfterRun = 20 * time.Second
	// A busy session spends every few seconds.
	spendPushAfter = 3 * time.Second
)

//go:embed pi_prices.json
var piPricesJSON []byte

var piPrices = func() map[string]map[string]Price {
	var rows [][]json.RawMessage
	if err := json.Unmarshal(piPricesJSON, &rows); err != nil {
		panic("runtime: pi_prices.json: " + err.Error())
	}
	out := map[string]map[string]Price{}
	for _, row := range rows {
		var provider, id string
		var n [4]float64
		_ = json.Unmarshal(row[0], &provider)
		_ = json.Unmarshal(row[1], &id)
		for i := range n {
			_ = json.Unmarshal(row[2+i], &n[i])
		}
		if out[provider] == nil {
			out[provider] = map[string]Price{}
		}
		out[provider][id] = Price{Input: n[0], Output: n[1], CacheRead: n[2], CacheWrite: n[3]}
	}
	return out
}()

// Registry is the farm's runtimes: smith's built-ins, vibevalley's own agent (it reads deepseekKey each session) and
// DeepSeek Harness. The server and the command line (`vibevalley oar`, `runtime chat`) know the same ones; tasks is
// where a vibevalley session keeps its task graph (the farm's database; nil on the command line, which never opens it).
func Registry(home string, deepseekKey func() string, tasks func(session string) engine.Store) *oar.RuntimeRegistry {
	vibevalley := oarruntime.VibeValleyRuntime(oarruntime.Options{
		Home: func() string { return home },
		Llm: func(_ context.Context, model string) (vvagent.LLM, error) {
			return vvagent.Deepseek(model, deepseekKey())
		},
		Tasks: tasks,
	})
	registry, err := oar.NewRuntimeRegistry(append(defaults.Runtimes(), vibevalley, dsh.Runtime())...)
	if err != nil {
		panic(err)
	}
	return registry
}

func today() string { return time.Now().Format("2006-01-02") }

type spend struct {
	Day       string             `json:"day"`
	ByRuntime map[string]float64 `json:"byRuntime"`
}

type Service struct {
	cfg       base.Config
	core      *core.Service
	store     *agent.Service
	Registry  *oar.RuntimeRegistry
	cnyPerUsd float64
	Probe     func(ctx context.Context, id string) protocol.RuntimeInfo
	usageOf   func(ctx context.Context, id string, runtime oar.Runtime, found oar.AvailableInstallation, settings protocol.RuntimeSettings) protocol.AccountUsage

	mu      sync.Mutex
	cache   map[string]observation
	pending map[string]*time.Timer
	pushes  map[string]*time.Timer
	spent   spend
	disk    *base.FileWriter
	saving  *time.Timer
	closed  bool
	asked   map[string]int
	// Each read of a runtime takes the next number when it starts (begin); the cache keeps the number of the read it
	// holds, and a read that started before it is dropped, so a slow probe never overwrites a newer one.
	reads map[string]uint64
}

func newService(cfg base.Config, db *sql.DB, core *core.Service, store *agent.Service, settings *setting.Service) (*Service, error) {
	spendFile := filepath.Join(cfg.Home, "spend.json")
	r := &Service{cfg: cfg, core: core, store: store, Registry: Registry(cfg.Home, settings.DeepseekAPIKey, func(session string) engine.Store { return engine.NewDBStore(db, session) }), cnyPerUsd: cfg.CNYPerUSD, cache: map[string]observation{},
		pending: map[string]*time.Timer{}, pushes: map[string]*time.Timer{}, asked: map[string]int{},
		reads: map[string]uint64{},
		disk:  base.NewFileWriter(spendFile, 0o644)}
	if testing.Testing() {
		// Tests never ask this machine's runtimes (their commands, their accounts): a test that wants one puts its own probe.
		r.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: store.Settings(id), CheckedAt: clock.NowMs()}
		}
	}
	r.usageOf = r.runtimeUsageOf
	r.spent = spend{Day: today(), ByRuntime: map[string]float64{}}
	if body, err := os.ReadFile(spendFile); err == nil {
		var kept spend
		if json.Unmarshal(body, &kept) == nil && kept.Day == today() && kept.ByRuntime != nil {
			r.spent = kept
		}
	}
	return r, nil
}

// In the background, so the first page load does not wait on every runtime.
func (r *Service) OnStart(ctx context.Context) error {
	go func() {
		r.each(ctx, func(id string) { r.Refresh(ctx, id) })
		ticker := time.NewTicker(usageEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.each(ctx, func(id string) { r.refreshUsage(ctx, id) })
			}
		}
	}()
	return nil
}

func (r *Service) each(ctx context.Context, f func(id string)) {
	slots := make(chan struct{}, 4)
	var group sync.WaitGroup
	for _, id := range protocol.RuntimeIDs() {
		if ctx.Err() != nil {
			break
		}
		slots <- struct{}{}
		group.Go(func() {
			defer func() { <-slots }()
			f(id)
		})
	}
	group.Wait()
}

func (r *Service) OnStop() {
	r.mu.Lock()
	r.closed = true
	if r.saving != nil {
		r.saving.Stop()
	}
	for _, t := range r.pending {
		t.Stop()
	}
	for _, t := range r.pushes {
		t.Stop()
	}
	r.mu.Unlock()
	if err := r.disk.Finish(r.spendBody); err != nil {
		log.Printf("vibevalley: could not save spend.json: %v", err)
	}
}

func (r *Service) spendBody() ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return json.Marshal(r.spent)
}

// A new day starts from nothing.
func (r *Service) tallyLocked() map[string]float64 {
	if r.spent.Day != today() {
		r.spent = spend{Day: today(), ByRuntime: map[string]float64{}}
	}
	return r.spent.ByRuntime
}

func (r *Service) withSpendLocked(info protocol.RuntimeInfo) protocol.RuntimeInfo {
	info.SpentToday = nil
	if cny, ok := r.tallyLocked()[info.ID]; ok {
		info.SpentToday = &cny
	}
	info.Stop = moneyStop(&info)
	info.Quota = quotaOf(info.Usage)
	return info
}

func (r *Service) Runtime(id string) (oar.Runtime, bool) { return r.Registry.Get(id) }

func piSettings() (provider, model string) {
	body, err := os.ReadFile(filepath.Join(pi.AgentDir(), "settings.json"))
	if err != nil {
		return "", ""
	}
	var s struct {
		DefaultProvider string `json:"defaultProvider"`
		DefaultModel    string `json:"defaultModel"`
	}
	_ = json.Unmarshal(body, &s)
	return s.DefaultProvider, s.DefaultModel
}

func piProvider(settings protocol.RuntimeSettings) string {
	if provider, _, _ := strings.Cut(settings.DefaultModel, "/"); strings.TrimSpace(provider) != "" {
		return strings.TrimSpace(provider)
	}
	provider, _ := piSettings()
	return provider
}

var envName = regexp.MustCompile(`^\$?\{?([A-Z][A-Z0-9_]*)\}?$`)

// piValue is a value from pi's config as pi reads it: the environment variable it names when one is set
// (DEEPSEEK_API_KEY, $DEEPSEEK_API_KEY, ${DEEPSEEK_API_KEY}), else itself. pi's `!command` values are not run.
func piValue(value string) string {
	if m := envName.FindStringSubmatch(value); m != nil {
		if v := os.Getenv(m[1]); v != "" {
			return v
		}
	}
	return value
}

// piDeepseek is the DeepSeek key pi itself uses and where it sends DeepSeek's requests, as pi's model runtime
// resolves them: the key in its auth.json, else DEEPSEEK_API_KEY, else its models.json's providers.deepseek.apiKey; the
// base URL in models.json's providers.deepseek.baseUrl, else DeepSeek's own. The base is without a trailing /v1 or
// slash: the balance is at <base>/user/balance.
func piDeepseek() (key, base string) {
	dir := pi.AgentDir()
	if body, err := os.ReadFile(filepath.Join(dir, "auth.json")); err == nil {
		var auth map[string]struct {
			Type string `json:"type"`
			Key  string `json:"key"`
		}
		if json.Unmarshal(body, &auth) == nil && auth["deepseek"].Key != "" {
			key = piValue(auth["deepseek"].Key)
		}
	}
	if key == "" {
		key = os.Getenv("DEEPSEEK_API_KEY")
	}
	base = "https://api.deepseek.com"
	if body, err := os.ReadFile(filepath.Join(dir, "models.json")); err == nil {
		var models struct {
			Providers map[string]struct {
				APIKey  string `json:"apiKey"`
				BaseURL string `json:"baseUrl"`
			} `json:"providers"`
		}
		if json.Unmarshal(body, &models) == nil {
			p := models.Providers["deepseek"]
			if key == "" && p.APIKey != "" {
				key = piValue(p.APIKey)
			}
			if p.BaseURL != "" {
				base = p.BaseURL
			}
		}
	}
	base = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(base, "/"), "/v1"), "/")
	return key, base
}

func unavailable(reason string) protocol.AccountUsage {
	return protocol.AccountUsage{Value: protocol.AccountUsageUnavailable{Reason: reason}}
}

func piBalance(ctx context.Context, settings protocol.RuntimeSettings) protocol.AccountUsage {
	provider := piProvider(settings)
	if provider != "deepseek" {
		if provider == "" {
			return unavailable("pi 没有设默认模型")
		}
		return unavailable(provider + " 不报余额")
	}
	key, base := piDeepseek()
	if key == "" {
		return protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/user/balance", nil)
	if err != nil {
		return unavailable(err.Error())
	}
	req.Header.Set("authorization", "Bearer "+key)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return unavailable(err.Error())
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return unavailable(fmt.Sprintf("HTTP %d", res.StatusCode))
	}
	var b struct {
		IsAvailable  *bool `json:"is_available"`
		BalanceInfos []struct {
			Currency     string `json:"currency"`
			TotalBalance string `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if json.NewDecoder(res.Body).Decode(&b) != nil {
		return unavailable("没读到 DeepSeek 余额")
	}
	usage := protocol.AccountUsageBalance{Provider: "DeepSeek", Available: b.IsAvailable == nil || *b.IsAvailable, Balances: []protocol.Balance{}}
	for _, x := range b.BalanceInfos {
		amount, _ := strconv.ParseFloat(x.TotalBalance, 64)
		usage.Balances = append(usage.Balances, protocol.Balance{Currency: x.Currency, Amount: amount})
	}
	return protocol.AccountUsage{Value: usage}
}

func piPrice(model string) *Price {
	if provider, id, ok := strings.Cut(model, "/"); ok {
		if p, ok := piPrices[provider][id]; ok {
			return &p
		}
		return nil
	}
	for _, provider := range sortedKeys(piPrices) {
		if p, ok := piPrices[provider][model]; ok {
			return &p
		}
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func fromOar(usage oar.AccountUsageSnapshot) protocol.AccountUsage {
	switch usage.Kind {
	case "reauth_required":
		return protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}
	case "unsupported":
		reason := usage.Reason
		if reason == "" {
			reason = "这个 runtime 不报用量"
		}
		return unavailable(reason)
	}
	ok := protocol.AccountUsageOk{Windows: []protocol.UsageWindow{}}
	if usage.Plan != "" {
		subscription := usage.Plan
		ok.Subscription = &subscription
	}
	for _, w := range usage.Windows {
		window := protocol.UsageWindow{Label: w.Label, UsedPercent: math.Round(w.UsedRatio * 100)}
		if at, err := time.Parse(time.RFC3339, w.ResetsAt); err == nil {
			ms := at.UnixMilli()
			window.ResetsAt = &ms
		}
		ok.Windows = append(ok.Windows, window)
	}
	return protocol.AccountUsage{Value: ok}
}

func (r *Service) runtimeUsageOf(ctx context.Context, id string, runtime oar.Runtime, found oar.AvailableInstallation, settings protocol.RuntimeSettings) protocol.AccountUsage {
	if id == "pi" {
		return piBalance(ctx, settings)
	}
	if runtime.AccountUsage == nil {
		return protocol.AccountUsage{}
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	usage, err := runtime.AccountUsage(ctx, found, oar.AccountUsageReadOptions{Timeout: probeTimeout})
	if err != nil || ctx.Err() != nil {
		return protocol.AccountUsage{}
	}
	return fromOar(usage)
}

func inventory[T any](ctx context.Context, read oar.InventoryReader[T], found oar.AvailableInstallation, cwd string, entry func(T) protocol.InventoryEntry) []protocol.InventoryEntry {
	if read == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	result, err := read(ctx, found, oar.InventoryOptions{Cwd: cwd, Timeout: probeTimeout})
	if err != nil || result.Kind != "ok" {
		return nil
	}
	out := []protocol.InventoryEntry{}
	for _, item := range result.Items {
		out = append(out, entry(item))
	}
	return out
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (r *Service) probe(ctx context.Context, id string) observation {
	settings := r.store.Settings(id)
	info := protocol.RuntimeInfo{ID: id, Settings: settings, CheckedAt: clock.NowMs()}
	runtime, ok := r.Runtime(id)
	if !ok {
		reason := "oar 不认识这个 runtime"
		if id == "cursor" {
			reason = "Cursor 要单独装它的 SDK（@cursor/sdk），VibeValley 还没接"
		}
		info.Installation = protocol.Installation{Value: protocol.InstallationUnsupported{Reason: reason}}
		return observation{Info: info}
	}
	var snapshot oar.InstallationSnapshot
	if runtime.Installation != nil {
		probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		snapshot, _ = runtime.Installation(probeCtx, oar.InstallationOptions{Binary: &settings.BinPath})
		cancel()
	}
	if snapshot.Kind != "available" {
		if snapshot.Kind == "unsupported" {
			info.Installation = protocol.Installation{Value: protocol.InstallationUnsupported{Reason: snapshot.Reason}}
		} else {
			info.Installation = protocol.Installation{Value: protocol.InstallationNotFound{}}
		}
		return observation{Info: info}
	}
	found := snapshot.Available
	if found.Via == "executable" {
		info.Installation = protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaExecutable, Command: found.Command, Version: optional(found.Version)}}
	} else {
		info.Installation = protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaBundled, Command: id}}
	}
	cwd := r.cfg.ProjectsDir()
	var group sync.WaitGroup
	group.Go(func() {
		if runtime.ListModels == nil {
			return
		}
		listCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		models, err := runtime.ListModels(listCtx, found, oar.ListModelsOptions{Timeout: probeTimeout})
		if err != nil || models.Kind != "ok" {
			return
		}
		info.Models = []protocol.ModelEntry{}
		for _, m := range models.Models {
			if m.Disabled != nil {
				continue
			}
			name := m.DisplayName
			if name == "" {
				name = m.ID
			}
			info.Models = append(info.Models, protocol.ModelEntry{ID: m.ID, Name: name, EffortLevels: append([]string{}, m.EffortLevels...), IsDefault: m.Default})
		}
	})
	group.Go(func() { info.Usage = r.usageOf(ctx, id, runtime, found, settings) })
	group.Go(func() {
		info.Skills = inventory(ctx, runtime.Skills, found, cwd, func(s oar.SkillEntry) protocol.InventoryEntry {
			source := s.Path
			if source == "" {
				source = s.Source
			}
			return protocol.InventoryEntry{Name: s.Name, Description: optional(s.Description), Source: optional(source), Enabled: s.Enabled}
		})
	})
	group.Go(func() {
		info.MCPServers = inventory(ctx, runtime.MCPServers, found, cwd, func(m oar.McpServerEntry) protocol.InventoryEntry {
			var parts []string
			if m.Status != "" {
				parts = append(parts, m.Status)
			}
			if m.ToolCount != nil {
				parts = append(parts, fmt.Sprintf("%d 个工具", *m.ToolCount))
			}
			return protocol.InventoryEntry{Name: m.Name, Description: optional(strings.Join(parts, " · ")), Source: optional(m.Source), Enabled: m.Enabled}
		})
	})
	group.Go(func() {
		info.Tools = inventory(ctx, runtime.Tools, found, cwd, func(t oar.ToolEntry) protocol.InventoryEntry {
			source := t.McpServerID
			if source == "" {
				source = t.Source
			}
			return protocol.InventoryEntry{Name: t.Name, Description: optional(t.Description), Source: optional(source), Enabled: t.Enabled}
		})
	})
	group.Wait()
	return observation{Info: info, Found: &found}
}

// Called with mu held.
func (r *Service) beginLocked(id string) uint64 {
	r.reads[id]++
	return r.reads[id]
}

func (r *Service) remember(next observation, read uint64) protocol.RuntimeInfo {
	r.mu.Lock()
	id := next.Info.ID
	if read < r.cache[id].Read {
		info := r.cache[id].Info
		r.mu.Unlock()
		return info
	}
	next.Read = read
	next.Info.Refused = r.refusals(id)
	next.Info = r.withSpendLocked(next.Info)
	r.cache[id] = next
	r.mu.Unlock()
	r.core.Runtime(next.Info)
	return next.Info
}

func knownRuntime(id string) bool {
	for _, known := range protocol.RuntimeIDs() {
		if known == id {
			return true
		}
	}
	return false
}

func (r *Service) Refresh(ctx context.Context, id string) *protocol.RuntimeInfo {
	if !knownRuntime(id) {
		return nil
	}
	r.mu.Lock()
	read := r.beginLocked(id)
	r.mu.Unlock()
	var next observation
	if r.Probe != nil {
		next.Info = r.Probe(ctx, id)
	} else {
		next = r.probe(ctx, id)
	}
	info := r.remember(next, read)
	return &info
}

func (r *Service) Info(ctx context.Context, id string) *protocol.RuntimeInfo {
	r.mu.Lock()
	hit, ok := r.cache[id]
	if ok {
		hit.Info = r.withSpendLocked(hit.Info)
	}
	r.mu.Unlock()
	if ok {
		return &hit.Info
	}
	return r.Refresh(ctx, id)
}

// The profile's issues as it would be dispatched now, against what its runtime is like (agentIssues).
func (r *Service) Check(ctx context.Context, agent protocol.Agent) []protocol.AgentIssue {
	return agentIssues(agent, r.Info(ctx, agent.Runtime))
}

func (r *Service) List(ctx context.Context) []protocol.RuntimeInfo {
	ids := protocol.RuntimeIDs()
	all := make([]*protocol.RuntimeInfo, len(ids))
	slots := make(chan struct{}, 4)
	var group sync.WaitGroup
	for i, id := range ids {
		slots <- struct{}{}
		group.Go(func() {
			defer func() { <-slots }()
			all[i] = r.Info(ctx, id)
		})
	}
	group.Wait()
	out := []protocol.RuntimeInfo{}
	for _, info := range all {
		if info != nil {
			out = append(out, *info)
		}
	}
	return out
}

func (r *Service) Update(ctx context.Context, id string, s protocol.RuntimeSettings) (*protocol.RuntimeInfo, error) {
	if !knownRuntime(id) {
		return nil, nil
	}
	if _, err := r.store.SaveSettings(id, s); err != nil {
		return nil, fmt.Errorf("save runtime %s settings: %w", id, err)
	}
	return r.Refresh(ctx, id), nil
}

func (r *Service) refreshUsage(ctx context.Context, id string) {
	runtime, ok := r.Runtime(id)
	r.mu.Lock()
	before, cached := r.cache[id]
	closed := r.closed
	read := r.beginLocked(id)
	r.mu.Unlock()
	// A runtime switched off is not asked: claude's reading, for one, calls its API every time.
	if closed || !ok || !cached || before.Found == nil || !before.Info.Settings.Enabled {
		return
	}
	usage := r.usageOf(ctx, id, runtime, *before.Found, before.Info.Settings)
	if reflect.DeepEqual(usage, before.Info.Usage) {
		return
	}
	before.Info.Usage, before.Info.CheckedAt = usage, clock.NowMs()
	r.remember(before, read)
}

func (r *Service) UsageAsked(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.asked[id]
}

func (r *Service) UsageSoon(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.asked[id]++
	if r.closed || r.pending[id] != nil {
		return
	}
	r.pending[id] = time.AfterFunc(usageAfterRun, func() {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		r.refreshUsage(context.Background(), id)
	})
}

func (r *Service) Price(id, model string) *Price {
	switch id {
	case oarruntime.VIBEVALLEY_RUNTIME:
		if model == "" {
			model = vvagent.DEFAULT_MODEL
		}
		if m, ok := ai.GetModel("deepseek", model); ok {
			return &Price{Input: m.Cost.Input, Output: m.Cost.Output, CacheRead: m.Cost.CacheRead, CacheWrite: m.Cost.CacheWrite}
		}
		return nil
	case "pi":
		if model == "" {
			provider, name := piSettings()
			if provider == "" || name == "" {
				return nil
			}
			model = provider + "/" + name
		}
		return piPrice(model)
	case "dsh":
		// dsh names a model provider/model (community/dsh ModelID); only DeepSeek's own is priced here. The retired name it
		// still lists, deepseek-v4-flash, is folded into deepseek-flash by the dsh adapter before a session names it.
		if provider, name, ok := strings.Cut(model, "/"); ok && provider == "deepseek-official" {
			if m, ok := ai.GetModel("deepseek", name); ok {
				return &Price{Input: m.Cost.Input, Output: m.Cost.Output, CacheRead: m.Cost.CacheRead, CacheWrite: m.Cost.CacheWrite}
			}
		}
		return nil
	}
	return nil
}

func (r *Service) Spend(id string, cny float64) {
	if !(cny > 0) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.tallyLocked()[id] += cny
	if r.saving != nil {
		r.saving.Stop()
	}
	r.saving = time.AfterFunc(time.Second, func() {
		if err := r.disk.Write(r.spendBody); err != nil {
			log.Printf("vibevalley: could not save spend.json: %v", err)
		}
	})
	// The pages hear about it a moment later, with whatever else was spent meanwhile.
	if r.pushes[id] == nil {
		r.pushes[id] = time.AfterFunc(spendPushAfter, func() {
			r.mu.Lock()
			delete(r.pushes, id)
			info, ok := r.cache[id]
			read := info.Read
			closed := r.closed
			r.mu.Unlock()
			if ok && !closed {
				r.remember(info, read)
			}
		})
	}
}
