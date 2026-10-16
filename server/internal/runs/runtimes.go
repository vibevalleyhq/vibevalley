package runs

import (
	"context"

	"vibevalley/internal/base"

	// The coding runtimes on this machine (ported from the TypeScript server's runtimes.ts, removed), as smith finds them: installed or not, their
	// models and how much is left on their accounts, plus vibevalley's own settings for each (Store). Probing runs a
	// runtime's own commands, so results are cached. Account usage moves while helpers work: it is read again every few
	// minutes and soon after a helper's turn, and every change goes out to the pages as a site event.
	//
	// It also keeps what each runtime's helpers spent today ($VIBEVALLEY_HOME/spend.json), priced from pi's price list
	// (crew_pi_prices.json, exported from pi by tool/pi-prices.ts: smith has no price list), so a daily budget can stop
	// new work (protocol MoneyStop).

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

	"vibevalley/internal/protocol"
	"vibevalley/pkg/agent"
	"vibevalley/pkg/agent/oarruntime"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/runtimes/defaults"
	"vibevalley/pkg/smith/runtimes/pi"
)

const (
	// crewProbeTimeout: how long one probe (installation, models, usage) may take before it counts as unknown.
	crewProbeTimeout = 10 * time.Second
	// crewUsageEvery: account usage is read again this often, whether or not anyone worked.
	crewUsageEvery = 5 * time.Minute
	// crewUsageAfterTurn: after a helper's turn, its runtime's usage is read again this much later (several turns share one read).
	crewUsageAfterTurn = 20 * time.Second
	// crewSpendPushAfter: a change to today's spend reaches the pages this much later (a busy helper spends every few seconds).
	crewSpendPushAfter = 3 * time.Second
)

//go:embed pi_prices.json
var crewPiPricesJSON []byte

// crewPiPrices is pi's price list: provider → model → price.
var crewPiPrices = func() map[string]map[string]base.Price {
	var rows [][]json.RawMessage
	if err := json.Unmarshal(crewPiPricesJSON, &rows); err != nil {
		panic("farm: crew_pi_prices.json: " + err.Error())
	}
	out := map[string]map[string]base.Price{}
	for _, row := range rows {
		var provider, id string
		var n [4]float64
		_ = json.Unmarshal(row[0], &provider)
		_ = json.Unmarshal(row[1], &id)
		for i := range n {
			_ = json.Unmarshal(row[2+i], &n[i])
		}
		if out[provider] == nil {
			out[provider] = map[string]base.Price{}
		}
		out[provider][id] = base.Price{Input: n[0], Output: n[1], CacheRead: n[2], CacheWrite: n[3]}
	}
	return out
}()

// crewRegistry is the runtimes helpers can run on: smith's built-ins, and vibevalley's own agent, which reads the
// DeepSeek key the farm's settings have (saved from the title screen, else the environment's, else pi's) each session.
func crewRegistry(home string, settings *base.Settings) *oar.RuntimeRegistry {
	vibevalley := oarruntime.VibeValleyRuntime(oarruntime.Options{
		Home: func() string { return home },
		Llm: func(_ context.Context, model string) (agent.LLM, error) {
			return agent.Deepseek(model, settings.DeepseekAPIKey())
		},
	})
	registry, err := oar.NewRuntimeRegistry(append(defaults.Runtimes(), vibevalley)...)
	if err != nil {
		panic(err)
	}
	return registry
}

// crewToday is today on this machine's clock: 2026-10-10.
func crewToday() string { return time.Now().Format("2006-01-02") }

// crewBinVar is smith's override of where a runtime's command lives: OAR_<RUNTIME>_BIN.
func crewBinVar(id string) string {
	return "OAR_" + strings.ReplaceAll(strings.ToUpper(id), "-", "_") + "_BIN"
}

type crewSpend struct {
	Day       string             `json:"day"`
	ByRuntime map[string]float64 `json:"byRuntime"`
}

type Runtimes struct {
	cfg   base.Config
	site  *base.Site
	store *base.Store
	// Registry is the runtimes helpers run on; a test puts scripted ones in before the farm starts.
	Registry  *oar.RuntimeRegistry
	cnyPerUsd float64
	// Probe reads a runtime's info: crewProbe; tests put their own, so nothing on the machine is asked.
	Probe func(ctx context.Context, id string) protocol.RuntimeInfo
	// usageOf reads a runtime's account usage: the runtime's reading, or pi's provider balance.
	usageOf func(ctx context.Context, id string, runtime oar.Runtime, found oar.AvailableInstallation, settings protocol.RuntimeSettings) protocol.AccountUsage

	mu    sync.Mutex
	cache map[string]protocol.RuntimeInfo
	// found are installations found, so a usage refresh need not look for the command again.
	found   map[string]oar.AvailableInstallation
	pending map[string]*time.Timer
	pushes  map[string]*time.Timer
	spent   crewSpend
	disk    *base.FileWriter
	saving  *time.Timer
	closed  bool
	// asked counts the usage reads asked for with UsageSoon, by runtime (tests read it).
	asked map[string]int
}

func newRuntimes(cfg base.Config, site *base.Site, store *base.Store, settings *base.Settings) (*Runtimes, error) {
	r := &Runtimes{cfg: cfg, site: site, store: store, Registry: crewRegistry(cfg.Home, settings), cnyPerUsd: 7.2, cache: map[string]protocol.RuntimeInfo{}, found: map[string]oar.AvailableInstallation{},
		pending: map[string]*time.Timer{}, pushes: map[string]*time.Timer{}, asked: map[string]int{},
		disk: base.NewFileWriter(filepath.Join(cfg.Home, "spend.json"), 0o644)}
	if v, err := strconv.ParseFloat(os.Getenv("VIBEVALLEY_CNY_PER_USD"), 64); err == nil {
		r.cnyPerUsd = v
	}
	r.Probe = r.crewProbe
	if testing.Testing() {
		// Tests never ask this machine's runtimes (their commands, their accounts): a test that wants one puts its own probe.
		r.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: store.Settings(id), CheckedAt: base.NowMs()}
		}
	}
	r.usageOf = r.crewUsageOf
	r.spent = crewSpend{Day: crewToday(), ByRuntime: map[string]float64{}}
	if body, err := os.ReadFile(filepath.Join(cfg.Home, "spend.json")); err == nil {
		var kept crewSpend
		if json.Unmarshal(body, &kept) == nil && kept.Day == crewToday() && kept.ByRuntime != nil {
			r.spent = kept
		}
	}
	return r, nil
}

// start probes every runtime once in the background, so the first page load does not wait on them all; then keeps
// the usage fresh.
func (r *Runtimes) OnStart(ctx context.Context) error {
	go func() {
		r.each(ctx, func(id string) { r.Refresh(ctx, id) })
		ticker := time.NewTicker(crewUsageEvery)
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

// each runs f for every runtime vibevalley knows, four at a time.
func (r *Runtimes) each(ctx context.Context, f func(id string)) {
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

func (r *Runtimes) OnStop() {
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
	if err := r.disk.Write(r.spendBody); err != nil {
		log.Printf("vibevalley: could not save spend.json: %v", err)
	}
}

func (r *Runtimes) spendBody() ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return json.Marshal(r.spent)
}

// tallyLocked is today's tally; a new day starts from nothing.
func (r *Runtimes) tallyLocked() map[string]float64 {
	if r.spent.Day != crewToday() {
		r.spent = crewSpend{Day: crewToday(), ByRuntime: map[string]float64{}}
	}
	return r.spent.ByRuntime
}

func (r *Runtimes) withSpendLocked(info protocol.RuntimeInfo) protocol.RuntimeInfo {
	if cny, ok := r.tallyLocked()[info.ID]; ok {
		info.SpentToday = &cny
	}
	return info
}

// Runtime is smith's runtime id; false for one this smith does not drive.
func (r *Runtimes) Runtime(id string) (oar.Runtime, bool) { return r.Registry.Get(id) }

// ── pi: pay as you go, so what is left is the provider's balance ─────────────

// crewPiSettings is pi's own settings (its agent dir's settings.json): its default provider and model.
func crewPiSettings() (provider, model string) {
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

// crewPiProvider is the provider pi's helpers run on: vibevalley's default model for pi, else pi's own default provider.
func crewPiProvider(settings protocol.RuntimeSettings) string {
	if provider, _, _ := strings.Cut(settings.DefaultModel, "/"); strings.TrimSpace(provider) != "" {
		return strings.TrimSpace(provider)
	}
	provider, _ := crewPiSettings()
	return provider
}

// crewEnvName is an environment variable a value in pi's config names instead of being one.
var crewEnvName = regexp.MustCompile(`^\$?\{?([A-Z][A-Z0-9_]*)\}?$`)

// crewPiValue is a value from pi's config as pi reads it: the environment variable it names when one is set
// (DEEPSEEK_API_KEY, $DEEPSEEK_API_KEY, ${DEEPSEEK_API_KEY}), else itself. pi's `!command` values are not run.
func crewPiValue(value string) string {
	if m := crewEnvName.FindStringSubmatch(value); m != nil {
		if v := os.Getenv(m[1]); v != "" {
			return v
		}
	}
	return value
}

// crewPiDeepseek is the DeepSeek key pi itself uses and where it sends DeepSeek's requests, as pi's model runtime
// resolves them (runtimes.ts asks pi's getAuth): the key in its auth.json, else DEEPSEEK_API_KEY, else its models.json's
// providers.deepseek.apiKey; the base URL in models.json's providers.deepseek.baseUrl, else DeepSeek's own. The base
// is without a trailing /v1 or slash: the balance is at <base>/user/balance.
func crewPiDeepseek() (key, base string) {
	dir := pi.AgentDir()
	if body, err := os.ReadFile(filepath.Join(dir, "auth.json")); err == nil {
		var auth map[string]struct {
			Type string `json:"type"`
			Key  string `json:"key"`
		}
		if json.Unmarshal(body, &auth) == nil && auth["deepseek"].Key != "" {
			key = crewPiValue(auth["deepseek"].Key)
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
				key = crewPiValue(p.APIKey)
			}
			if p.BaseURL != "" {
				base = p.BaseURL
			}
		}
	}
	base = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(base, "/"), "/v1"), "/")
	return key, base
}

func crewUnavailable(reason string) protocol.AccountUsage {
	return protocol.AccountUsage{Value: protocol.AccountUsageUnavailable{Reason: reason}}
}

// crewPiBalance is DeepSeek's balance, with the key pi itself uses for it. Other providers report none.
func crewPiBalance(ctx context.Context, settings protocol.RuntimeSettings) protocol.AccountUsage {
	provider := crewPiProvider(settings)
	if provider != "deepseek" {
		if provider == "" {
			return crewUnavailable("pi 没有设默认模型")
		}
		return crewUnavailable(provider + " 不报余额")
	}
	key, base := crewPiDeepseek()
	if key == "" {
		return protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}
	}
	ctx, cancel := context.WithTimeout(ctx, crewProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/user/balance", nil)
	if err != nil {
		return crewUnavailable(err.Error())
	}
	req.Header.Set("authorization", "Bearer "+key)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return crewUnavailable(err.Error())
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return crewUnavailable(fmt.Sprintf("HTTP %d", res.StatusCode))
	}
	var b struct {
		IsAvailable  *bool `json:"is_available"`
		BalanceInfos []struct {
			Currency     string `json:"currency"`
			TotalBalance string `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if json.NewDecoder(res.Body).Decode(&b) != nil {
		return crewUnavailable("没读到 DeepSeek 余额")
	}
	usage := protocol.AccountUsageBalance{Provider: "DeepSeek", Available: b.IsAvailable == nil || *b.IsAvailable, Balances: []protocol.Balance{}}
	for _, x := range b.BalanceInfos {
		amount, _ := strconv.ParseFloat(x.TotalBalance, 64)
		usage.Balances = append(usage.Balances, protocol.Balance{Currency: x.Currency, Amount: amount})
	}
	return protocol.AccountUsage{Value: usage}
}

// crewPiPrice is pi's price for provider/model (or a bare model id, looked up across providers).
func crewPiPrice(model string) *base.Price {
	if provider, id, ok := strings.Cut(model, "/"); ok {
		if p, ok := crewPiPrices[provider][id]; ok {
			return &p
		}
		return nil
	}
	for _, provider := range crewSortedKeys(crewPiPrices) {
		if p, ok := crewPiPrices[provider][model]; ok {
			return &p
		}
	}
	return nil
}

func crewSortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// crewFromOar is smith's account usage reading as the farm shows it.
func crewFromOar(usage oar.AccountUsageSnapshot) protocol.AccountUsage {
	switch usage.Kind {
	case "reauth_required":
		return protocol.AccountUsage{Value: protocol.AccountUsageLoginRequired{}}
	case "unsupported":
		reason := usage.Reason
		if reason == "" {
			reason = "这个 runtime 不报用量"
		}
		return crewUnavailable(reason)
	}
	ok := protocol.AccountUsageOk{Windows: []protocol.UsageWindow{}}
	if usage.Plan != "" {
		plan := usage.Plan
		ok.Plan = &plan
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

// crewUsageOf is how much is left on this runtime's account: smith's reading, or pi's provider balance. Zero when
// it cannot tell.
func (r *Runtimes) crewUsageOf(ctx context.Context, id string, runtime oar.Runtime, found oar.AvailableInstallation, settings protocol.RuntimeSettings) protocol.AccountUsage {
	if id == "pi" {
		return crewPiBalance(ctx, settings)
	}
	if runtime.AccountUsage == nil {
		return protocol.AccountUsage{}
	}
	ctx, cancel := context.WithTimeout(ctx, crewProbeTimeout)
	defer cancel()
	usage, err := runtime.AccountUsage(ctx, found, oar.AccountUsageReadOptions{Timeout: crewProbeTimeout})
	if err != nil || ctx.Err() != nil {
		return protocol.AccountUsage{}
	}
	return crewFromOar(usage)
}

// ── Probing ──────────────────────────────────────────────────────────────────

func crewInventory[T any](ctx context.Context, read oar.InventoryReader[T], found oar.AvailableInstallation, cwd string, entry func(T) protocol.InventoryEntry) []protocol.InventoryEntry {
	if read == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, crewProbeTimeout)
	defer cancel()
	result, err := read(ctx, found, oar.InventoryOptions{Cwd: cwd, Timeout: crewProbeTimeout})
	if err != nil || result.Kind != "ok" {
		return nil
	}
	out := []protocol.InventoryEntry{}
	for _, item := range result.Items {
		out = append(out, entry(item))
	}
	return out
}

func crewOptional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// crewProbe reads a runtime's installation, models, usage and inventories, each within crewProbeTimeout.
func (r *Runtimes) crewProbe(ctx context.Context, id string) protocol.RuntimeInfo {
	settings := r.store.Settings(id)
	if bin := strings.TrimSpace(settings.BinPath); bin != "" {
		os.Setenv(crewBinVar(id), bin)
	} else {
		os.Unsetenv(crewBinVar(id))
	}
	info := protocol.RuntimeInfo{ID: id, Settings: settings, CheckedAt: base.NowMs()}
	runtime, ok := r.Runtime(id)
	if !ok {
		reason := "oar 不认识这个 runtime"
		if id == "cursor" {
			reason = "Cursor 要单独装它的 SDK（@cursor/sdk），VibeValley 还没接"
		}
		info.Installation = protocol.Installation{Value: protocol.InstallationUnsupported{Reason: reason}}
		return info
	}
	var snapshot oar.InstallationSnapshot
	if runtime.Installation != nil {
		probeCtx, cancel := context.WithTimeout(ctx, crewProbeTimeout)
		snapshot, _ = runtime.Installation(probeCtx)
		cancel()
	}
	if snapshot.Kind != "available" {
		r.mu.Lock()
		delete(r.found, id)
		r.mu.Unlock()
		if snapshot.Kind == "unsupported" {
			info.Installation = protocol.Installation{Value: protocol.InstallationUnsupported{Reason: snapshot.Reason}}
		} else {
			info.Installation = protocol.Installation{Value: protocol.InstallationNotFound{}}
		}
		return info
	}
	found := snapshot.Available
	r.mu.Lock()
	r.found[id] = found
	r.mu.Unlock()
	if found.Via == "executable" {
		info.Installation = protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaExecutable, Command: found.Command, Version: crewOptional(found.Version)}}
	} else {
		info.Installation = protocol.Installation{Value: protocol.InstallationAvailable{Via: protocol.ViaBundled, Command: id}}
	}
	cwd := r.cfg.WorkRoot
	var group sync.WaitGroup
	group.Go(func() {
		if runtime.ListModels == nil {
			return
		}
		listCtx, cancel := context.WithTimeout(ctx, crewProbeTimeout)
		defer cancel()
		models, err := runtime.ListModels(listCtx, found, oar.ListModelsOptions{Timeout: crewProbeTimeout})
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
		info.Skills = crewInventory(ctx, runtime.Skills, found, cwd, func(s oar.SkillEntry) protocol.InventoryEntry {
			source := s.Path
			if source == "" {
				source = s.Source
			}
			return protocol.InventoryEntry{Name: s.Name, Description: crewOptional(s.Description), Source: crewOptional(source), Enabled: s.Enabled}
		})
	})
	group.Go(func() {
		info.MCPServers = crewInventory(ctx, runtime.MCPServers, found, cwd, func(m oar.McpServerEntry) protocol.InventoryEntry {
			var parts []string
			if m.Status != "" {
				parts = append(parts, m.Status)
			}
			if m.ToolCount != nil {
				parts = append(parts, fmt.Sprintf("%d 个工具", *m.ToolCount))
			}
			return protocol.InventoryEntry{Name: m.Name, Description: crewOptional(strings.Join(parts, " · ")), Source: crewOptional(m.Source), Enabled: m.Enabled}
		})
	})
	group.Go(func() {
		info.Tools = crewInventory(ctx, runtime.Tools, found, cwd, func(t oar.ToolEntry) protocol.InventoryEntry {
			source := t.McpServerID
			if source == "" {
				source = t.Source
			}
			return protocol.InventoryEntry{Name: t.Name, Description: crewOptional(t.Description), Source: crewOptional(source), Enabled: t.Enabled}
		})
	})
	group.Wait()
	return info
}

// remember caches a runtime's info and tells the pages.
func (r *Runtimes) remember(raw protocol.RuntimeInfo) protocol.RuntimeInfo {
	r.mu.Lock()
	info := r.withSpendLocked(raw)
	r.cache[info.ID] = info
	r.mu.Unlock()
	r.site.Runtime(info)
	return info
}

func crewKnownRuntime(id string) bool {
	for _, known := range protocol.RuntimeIDs() {
		if known == id {
			return true
		}
	}
	return false
}

// Refresh probes a runtime again; nil for one vibevalley does not know.
func (r *Runtimes) Refresh(ctx context.Context, id string) *protocol.RuntimeInfo {
	if !crewKnownRuntime(id) {
		return nil
	}
	info := r.remember(r.Probe(ctx, id))
	return &info
}

// Info is the cached info, probing once if there is none.
func (r *Runtimes) Info(ctx context.Context, id string) *protocol.RuntimeInfo {
	r.mu.Lock()
	hit, ok := r.cache[id]
	r.mu.Unlock()
	if ok {
		return &hit
	}
	return r.Refresh(ctx, id)
}

func (r *Runtimes) List(ctx context.Context) []protocol.RuntimeInfo {
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

func (r *Runtimes) Update(ctx context.Context, id string, s protocol.RuntimeSettings) *protocol.RuntimeInfo {
	if _, err := r.store.SaveSettings(id, s); err != nil {
		log.Printf("vibevalley: could not save the settings of %s: %v", id, err)
	}
	return r.Refresh(ctx, id)
}

// refreshUsage reads just the account usage again; tells the pages only when it changed.
func (r *Runtimes) refreshUsage(ctx context.Context, id string) {
	runtime, ok := r.Runtime(id)
	r.mu.Lock()
	found, hasFound := r.found[id]
	before, cached := r.cache[id]
	closed := r.closed
	r.mu.Unlock()
	// A runtime switched off is not asked: claude's reading, for one, calls its API every time.
	if closed || !ok || !hasFound || !cached || !before.Settings.Enabled {
		return
	}
	usage := r.usageOf(ctx, id, runtime, found, before.Settings)
	if reflect.DeepEqual(usage, before.Usage) {
		return
	}
	before.Usage, before.CheckedAt = usage, base.NowMs()
	r.remember(before)
}

// UsageAsked is how many usage reads of the runtime were asked for with UsageSoon.
func (r *Runtimes) UsageAsked(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.asked[id]
}

// UsageSoon reads the runtime's account usage again in a little while: a helper on it just used some.
func (r *Runtimes) UsageSoon(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.asked[id]++
	if r.closed || r.pending[id] != nil {
		return
	}
	r.pending[id] = time.AfterFunc(crewUsageAfterTurn, func() {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
		r.refreshUsage(context.Background(), id)
	})
}

// Price is a model's price, for a model as the runtime names it (pi: provider/model); nil when unknown.
func (r *Runtimes) Price(id, model string) *base.Price {
	switch id {
	case oarruntime.VIBEVALLEY_RUNTIME:
		// vibevalley's own agent: the price in vibevalley/ai's model list (DeepSeek's), the default model when none is named.
		if model == "" {
			model = agent.DEFAULT_MODEL
		}
		if m, ok := ai.GetModel("deepseek", model); ok {
			return &base.Price{Input: m.Cost.Input, Output: m.Cost.Output, CacheRead: m.Cost.CacheRead, CacheWrite: m.Cost.CacheWrite}
		}
		return nil
	case "pi":
		if model == "" {
			provider, name := crewPiSettings()
			if provider == "" || name == "" {
				return nil
			}
			model = provider + "/" + name
		}
		return crewPiPrice(model)
	}
	return nil
}

// CnyPerUsd: prices are in dollars; the farm talks in yuan (VIBEVALLEY_CNY_PER_USD, default 7.2).
func (r *Runtimes) CnyPerUsd() float64 { return r.cnyPerUsd }

// Spend adds to what the runtime's helpers spent today.
func (r *Runtimes) Spend(id string, cny float64) {
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
		r.pushes[id] = time.AfterFunc(crewSpendPushAfter, func() {
			r.mu.Lock()
			delete(r.pushes, id)
			info, ok := r.cache[id]
			closed := r.closed
			r.mu.Unlock()
			if ok && !closed {
				r.remember(info)
			}
		})
	}
}
