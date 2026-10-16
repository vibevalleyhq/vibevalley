package oar

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Runtime is one provider-independent runtime adoption unit
// (contracts/runtime.ts). A nil function field is an absent capability.
type Runtime struct {
	ID    string
	Brand RuntimeBrand
	// The core capability: a runtime without sessions is not usable.
	Session StartSession
	// Declared before any session opens; Session refuses the same options.
	RefusedSessionOptions RefusedSessionOptions

	Installation InstallationProbe
	InstallPlan  InstallPlanner
	Install      Installer
	InstallLines []InstallLine
	AccountUsage AccountUsageReader
	ListModels   ModelLister
	CheckUpdate  UpdateChecker
	Upgrade      Upgrader
	Login        RuntimeLogin
	Logout       RuntimeLogout
	AuthStatus   AuthStatusReader

	Skills     InventoryReader[SkillEntry]
	Commands   InventoryReader[CommandEntry]
	MCPServers InventoryReader[McpServerEntry]
	Tools      InventoryReader[ToolEntry]
}

// DefineRuntime fills the inventory readers a runtime leaves out with
// `unsupported` answers and the brand with the id (contracts/runtime.ts defineRuntime).
func DefineRuntime(runtime Runtime) Runtime {
	if runtime.Brand.Name == "" {
		runtime.Brand = RuntimeBrand{Name: runtime.ID}
	}
	if runtime.Skills == nil {
		runtime.Skills = unsupportedInventory[SkillEntry]
	}
	if runtime.Commands == nil {
		runtime.Commands = unsupportedInventory[CommandEntry]
	}
	if runtime.MCPServers == nil {
		runtime.MCPServers = unsupportedInventory[McpServerEntry]
	}
	if runtime.Tools == nil {
		runtime.Tools = unsupportedInventory[ToolEntry]
	}
	return runtime
}

func unsupportedInventory[T any](context.Context, AvailableInstallation, InventoryOptions) (InventoryResult[T], error) {
	return InventoryResult[T]{Kind: "unsupported", Code: "transport_unavailable", Reason: "The selected runtime interface does not expose this inventory"}, nil
}

// RuntimeBrand is a runtime's display name and icons (self-contained SVG
// data URIs). Icon "" means no icon (TS null). IconLight / IconDark are the
// variants for the host's background, when the brand has them.
type RuntimeBrand struct {
	Name      string
	Icon      string
	IconLight string
	IconDark  string
}

func (b RuntimeBrand) MarshalJSON() ([]byte, error) {
	o := newObject()
	_ = o.field("name", b.Name)
	if b.Icon == "" {
		o.raw("icon", []byte("null"))
	} else {
		_ = o.field("icon", b.Icon)
	}
	if b.IconLight != "" || b.IconDark != "" {
		icons := map[string]string{}
		if b.IconLight != "" {
			icons["light"] = b.IconLight
		}
		if b.IconDark != "" {
			icons["dark"] = b.IconDark
		}
		_ = o.field("icons", icons)
	}
	return o.bytes(), nil
}

func (b *RuntimeBrand) UnmarshalJSON(data []byte) error {
	var wire struct {
		Name  string  `json:"name"`
		Icon  *string `json:"icon"`
		Icons *struct {
			Light string `json:"light"`
			Dark  string `json:"dark"`
		} `json:"icons"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*b = RuntimeBrand{Name: wire.Name}
	if wire.Icon != nil {
		b.Icon = *wire.Icon
	}
	if wire.Icons != nil {
		b.IconLight, b.IconDark = wire.Icons.Light, wire.Icons.Dark
	}
	return nil
}

// IconFor selects the icon for the host's background ("light" or "dark"),
// falling back to Icon (runtimeBrandIcon).
func (b RuntimeBrand) IconFor(theme string) string {
	if theme == "light" && b.IconLight != "" {
		return b.IconLight
	}
	if theme == "dark" && b.IconDark != "" {
		return b.IconDark
	}
	return b.Icon
}

// ─── Installation ──────────────────────────────────────────────────────────

// AvailableInstallation is a verified executable (Via "executable": Command,
// Version, Shadowed) or a bundled runtime (Via "bundled").
type AvailableInstallation struct {
	Via      string   `json:"via"`
	Command  string   `json:"command,omitempty"`
	Version  string   `json:"version,omitempty"`
	Shadowed []string `json:"shadowed,omitempty"`
}

// IsExecutable reports a machine-installed executable.
func (a AvailableInstallation) IsExecutable() bool { return a.Via == "executable" }

func (a AvailableInstallation) MarshalJSON() ([]byte, error) {
	type t AvailableInstallation
	return withKind("available", t(a))
}

// InstallationSnapshot is "available" (Available set), "not_found" or "unsupported" (Reason).
type InstallationSnapshot struct {
	Kind      string
	Available AvailableInstallation
	Reason    string
}

// Available builds an available snapshot.
func Available(installation AvailableInstallation) InstallationSnapshot {
	return InstallationSnapshot{Kind: "available", Available: installation}
}

func (s InstallationSnapshot) MarshalJSON() ([]byte, error) {
	switch s.Kind {
	case "available":
		return json.Marshal(s.Available)
	case "unsupported":
		return json.Marshal(struct {
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		}{s.Kind, s.Reason})
	default:
		return json.Marshal(struct {
			Kind string `json:"kind"`
		}{s.Kind})
	}
}

func (s *InstallationSnapshot) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind   string `json:"kind"`
		Reason string `json:"reason"`
		AvailableInstallation
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*s = InstallationSnapshot{Kind: wire.Kind, Reason: wire.Reason}
	if wire.Kind == "available" {
		s.Available = wire.AvailableInstallation
	}
	return nil
}

// InstallationProbe is a local-only installation observation.
type InstallationProbe func(ctx context.Context) (InstallationSnapshot, error)

// ─── Models ────────────────────────────────────────────────────────────────

// ModelEntry is one model the runtime will accept as a session model right now.
type ModelEntry struct {
	ID                 string              `json:"id"`
	ResolvedID         string              `json:"resolvedId,omitempty"`
	DisplayName        string              `json:"displayName,omitempty"`
	EffortLevels       []string            `json:"effortLevels,omitempty"`
	DefaultEffort      string              `json:"defaultEffort,omitempty"`
	ServiceTiers       []string            `json:"serviceTiers,omitempty"`
	DefaultServiceTier string              `json:"defaultServiceTier,omitempty"`
	Disabled           *ModelDisabled      `json:"disabled,omitempty"`
	Default            bool                `json:"default,omitempty"`
	Provider           *ModelEntryProvider `json:"provider,omitempty"`
}

// MarshalJSON keeps an empty effort or tier menu as [], as TS sends it;
// only a nil menu is absent.
func (m ModelEntry) MarshalJSON() ([]byte, error) {
	type t ModelEntry
	encoded, err := json.Marshal(t(m))
	if err != nil || (m.EffortLevels == nil || len(m.EffortLevels) > 0) && (m.ServiceTiers == nil || len(m.ServiceTiers) > 0) {
		return encoded, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return nil, err
	}
	if m.EffortLevels != nil && len(m.EffortLevels) == 0 {
		fields["effortLevels"] = json.RawMessage("[]")
	}
	if m.ServiceTiers != nil && len(m.ServiceTiers) == 0 {
		fields["serviceTiers"] = json.RawMessage("[]")
	}
	return json.Marshal(fields)
}

type ModelDisabled struct {
	Reason string `json:"reason"`
}

type ModelEntryProvider struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
}

// ListModelsResult is "ok" (Models), "unauthenticated" (Detail) or "unsupported" (Reason).
type ListModelsResult struct {
	Kind   string       `json:"kind"`
	Models []ModelEntry `json:"models,omitempty"`
	Detail string       `json:"detail,omitempty"`
	Reason string       `json:"reason,omitempty"`
}

func (r ListModelsResult) MarshalJSON() ([]byte, error) {
	o := newObject()
	_ = o.field("kind", r.Kind)
	switch r.Kind {
	case "ok":
		_ = o.field("models", nonNil(r.Models))
	case "unauthenticated":
		if r.Detail != "" {
			_ = o.field("detail", r.Detail)
		}
	default:
		_ = o.field("reason", r.Reason)
	}
	return o.bytes(), nil
}

type ListModelsOptions struct {
	// The directory a session would run in; the host's cwd when empty.
	Cwd     string
	Timeout time.Duration
}

type ModelLister func(ctx context.Context, installation AvailableInstallation, options ListModelsOptions) (ListModelsResult, error)

// ─── Account usage ─────────────────────────────────────────────────────────

// UtcInstantFromTime renders a time in the canonical form Date.toISOString produces.
func UtcInstantFromTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

type AccountUsageWindow struct {
	Label      string  `json:"label"`
	UsedRatio  float64 `json:"usedRatio"`
	ResetsAt   string  `json:"resetsAt,omitempty"`
	ID         string  `json:"id,omitempty"`
	DurationMs *int64  `json:"durationMs,omitempty"`
}

// AccountUsageSnapshot is "available" (Plan, Email, DisplayName,
// RateLimited, Windows), "reauth_required" (Reason) or "unsupported" (Reason).
type AccountUsageSnapshot struct {
	Kind        string
	Plan        string
	Email       string
	DisplayName string
	RateLimited bool
	Windows     []AccountUsageWindow
	Reason      string
}

func (s AccountUsageSnapshot) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", s.Kind); err != nil {
		return nil, err
	}
	if s.Kind == "available" {
		for _, f := range []struct{ name, value string }{{"plan", s.Plan}, {"email", s.Email}, {"displayName", s.DisplayName}} {
			if f.value != "" {
				if err := o.field(f.name, f.value); err != nil {
					return nil, err
				}
			}
		}
		if err := o.field("rateLimited", s.RateLimited); err != nil {
			return nil, err
		}
		windows := s.Windows
		if windows == nil {
			windows = []AccountUsageWindow{}
		}
		if err := o.field("windows", windows); err != nil {
			return nil, err
		}
	} else if s.Reason != "" {
		if err := o.field("reason", s.Reason); err != nil {
			return nil, err
		}
	}
	return o.bytes(), nil
}

func (s *AccountUsageSnapshot) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind        string               `json:"kind"`
		Plan        string               `json:"plan"`
		Email       string               `json:"email"`
		DisplayName string               `json:"displayName"`
		RateLimited bool                 `json:"rateLimited"`
		Windows     []AccountUsageWindow `json:"windows"`
		Reason      string               `json:"reason"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*s = AccountUsageSnapshot(wire)
	return nil
}

type AccountUsageReadOptions struct {
	// Bounds the whole read; each reader has its own default.
	Timeout time.Duration
}

type AccountUsageReader func(ctx context.Context, installation AvailableInstallation, options AccountUsageReadOptions) (AccountUsageSnapshot, error)

// ─── Install ───────────────────────────────────────────────────────────────

type InstallStep struct {
	Command []string `json:"command"`
	Display string   `json:"display"`
}

type InstallLine struct {
	Line        string `json:"line"`
	Description string `json:"description"`
}

// InstallPlan is "plan" (Steps, Source; network true, privileges false) or
// "unsupported" (Reason, Detail, and Steps/Source for requires_privileges and missing_tool).
type InstallPlan struct {
	Kind   string
	Steps  []InstallStep
	Source string
	Reason string
	Detail string
}

func (p InstallPlan) MarshalJSON() ([]byte, error) {
	o := newObject()
	if err := o.field("kind", p.Kind); err != nil {
		return nil, err
	}
	if p.Kind == "plan" {
		_ = o.field("steps", nonNil(p.Steps))
		_ = o.field("source", p.Source)
		_ = o.field("network", true)
		_ = o.field("privileges", false)
		return o.bytes(), nil
	}
	_ = o.field("reason", p.Reason)
	if p.Detail != "" {
		_ = o.field("detail", p.Detail)
	}
	if p.Steps != nil {
		_ = o.field("steps", p.Steps)
		_ = o.field("source", p.Source)
	}
	return o.bytes(), nil
}

func (p *InstallPlan) UnmarshalJSON(data []byte) error {
	var wire struct {
		Kind   string        `json:"kind"`
		Steps  []InstallStep `json:"steps"`
		Source string        `json:"source"`
		Reason string        `json:"reason"`
		Detail string        `json:"detail"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*p = InstallPlan(wire)
	return nil
}

// InstallResult is "installed" (Installation, Line, Output), "already_installed"
// (Installation, Line), "failed" (ExitCode, Output) or "unsupported" (as InstallPlan).
type InstallResult struct {
	Kind         string
	Installation AvailableInstallation
	Line         string
	Output       string
	ExitCode     *int
	Unsupported  InstallPlan
}

func (r InstallResult) MarshalJSON() ([]byte, error) {
	switch r.Kind {
	case "unsupported":
		return json.Marshal(r.Unsupported)
	case "failed":
		return json.Marshal(struct {
			Kind     string `json:"kind"`
			ExitCode *int   `json:"exitCode"`
			Output   string `json:"output"`
		}{r.Kind, r.ExitCode, r.Output})
	}
	o := newObject()
	_ = o.field("kind", r.Kind)
	_ = o.field("installation", r.Installation)
	if r.Line != "" {
		_ = o.field("line", r.Line)
	}
	if r.Kind == "installed" {
		_ = o.field("output", r.Output)
	}
	return o.bytes(), nil
}

type InstallOptions struct {
	Timeout time.Duration
	Line    string
}

type InstallPlanner func(ctx context.Context, options InstallOptions) (InstallPlan, error)
type Installer func(ctx context.Context, options InstallOptions) (InstallResult, error)

// ─── Update ────────────────────────────────────────────────────────────────

// UpdateCheck is "ok" (Installed, Latest, UpdateAvailable, Channel, Source)
// or "unavailable" (Reason, Detail, Source).
type UpdateCheck struct {
	Kind            string `json:"kind"`
	Installed       string `json:"installed,omitempty"`
	Latest          string `json:"latest,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable,omitempty"`
	Channel         string `json:"channel,omitempty"`
	Source          string `json:"source,omitempty"`
	Reason          string `json:"reason,omitempty"`
	Detail          string `json:"detail,omitempty"`
}

func (c UpdateCheck) MarshalJSON() ([]byte, error) {
	type t UpdateCheck
	encoded, err := json.Marshal(t(c))
	if err != nil || c.Kind != "ok" || c.UpdateAvailable {
		return encoded, err
	}
	// TS always sends updateAvailable on an ok check.
	return append(encoded[:len(encoded)-1], []byte(`,"updateAvailable":false}`)...), nil
}

type UpdateCheckOptions struct{ Timeout time.Duration }

type UpdateChecker func(ctx context.Context, installation AvailableInstallation, options UpdateCheckOptions) (UpdateCheck, error)

// UpgradeResult is "upgraded" (From, To, Output), "current" (Version, Check),
// "unchanged" (Version, Output), "failed" (ExitCode, Output) or "unsupported" (Reason, Detail).
type UpgradeResult struct {
	Kind     string       `json:"kind"`
	From     string       `json:"from,omitempty"`
	To       string       `json:"to,omitempty"`
	Version  string       `json:"version,omitempty"`
	Check    *UpdateCheck `json:"check,omitempty"`
	Output   *string      `json:"output,omitempty"`
	ExitCode *NullInt     `json:"exitCode,omitempty"`
	Reason   string       `json:"reason,omitempty"`
	Detail   string       `json:"detail,omitempty"`
}

type UpgradeOptions struct{ Timeout time.Duration }

type Upgrader func(ctx context.Context, installation AvailableInstallation, options UpgradeOptions) (UpgradeResult, error)

// ─── Login ─────────────────────────────────────────────────────────────────

type LoginAccount struct {
	Email     string `json:"email,omitempty"`
	Plan      string `json:"plan,omitempty"`
	Method    string `json:"method,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

// LoginResult is "logged_in" (Account), "failed" (Reason, Detail),
// "cancelled" or "unsupported" (Reason, Detail).
type LoginResult struct {
	Kind    string        `json:"kind"`
	Account *LoginAccount `json:"account,omitempty"`
	Reason  string        `json:"reason,omitempty"`
	Detail  string        `json:"detail,omitempty"`
}

type LoginOptions struct{ Timeout time.Duration }

// ProviderLoginEvent is "auth_url" (URL, Instructions), "device_code"
// (UserCode, VerificationURI, IntervalSeconds, ExpiresInSeconds) or "info" (Message).
type ProviderLoginEvent struct {
	Kind             string `json:"kind"`
	URL              string `json:"url,omitempty"`
	Instructions     string `json:"instructions,omitempty"`
	UserCode         string `json:"userCode,omitempty"`
	VerificationURI  string `json:"verificationUri,omitempty"`
	IntervalSeconds  *int   `json:"intervalSeconds,omitempty"`
	ExpiresInSeconds *int   `json:"expiresInSeconds,omitempty"`
	Message          string `json:"message,omitempty"`
}

// ProviderLoginPrompt is "text", "secret", "manual_code" (Message,
// Placeholder) or "select" (Message, Options).
type ProviderLoginPrompt struct {
	Kind        string                      `json:"kind"`
	Message     string                      `json:"message"`
	Placeholder string                      `json:"placeholder,omitempty"`
	Options     []ProviderLoginPromptOption `json:"options,omitempty"`
}

type ProviderLoginPromptOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// ProviderLoginInteraction lets a login flow surface events and ask the caller.
// Cancelling the login's context aborts it.
type ProviderLoginInteraction struct {
	OnEvent func(ProviderLoginEvent)
	Prompt  func(ctx context.Context, prompt ProviderLoginPrompt) (string, error)
}

type RuntimeLogin func(ctx context.Context, installation AvailableInstallation, interaction ProviderLoginInteraction, options LoginOptions) (LoginResult, error)

// LogoutResult is "logged_out", "failed" (Reason, Detail) or "unsupported" (Reason, Detail).
type LogoutResult struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type LogoutOptions struct{ Timeout time.Duration }

type RuntimeLogout func(ctx context.Context, installation AvailableInstallation, options LogoutOptions) (LogoutResult, error)

// AuthStatus is "logged_in" (Account, Source), "logged_out" (Source) or "unknown" (Detail, Source).
type AuthStatus struct {
	Kind    string        `json:"kind"`
	Account *LoginAccount `json:"account,omitempty"`
	Source  string        `json:"source,omitempty"`
	Detail  string        `json:"detail,omitempty"`
}

type AuthStatusOptions struct{ Timeout time.Duration }

type AuthStatusReader func(ctx context.Context, installation AvailableInstallation, options AuthStatusOptions) (AuthStatus, error)

// ─── Inventory ─────────────────────────────────────────────────────────────

type InventoryScope struct {
	Kind string `json:"kind"`
	Cwd  string `json:"cwd"`
}

type InventoryOptions struct {
	// The host's cwd when empty.
	Cwd     string
	Timeout time.Duration
}

type SkillEntry struct {
	Name                   string `json:"name"`
	Description            string `json:"description,omitempty"`
	Path                   string `json:"path,omitempty"`
	Source                 string `json:"source,omitempty"`
	Enabled                *bool  `json:"enabled,omitempty"`
	DisableModelInvocation *bool  `json:"disableModelInvocation,omitempty"`
}

type CommandEntry struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Source       string   `json:"source,omitempty"`
	ArgumentHint string   `json:"argumentHint,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
}

type McpServerEntry struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status,omitempty"`
	AuthStatus string `json:"authStatus,omitempty"`
	Enabled    *bool  `json:"enabled,omitempty"`
	Source     string `json:"source,omitempty"`
	ToolCount  *int   `json:"toolCount,omitempty"`
	Error      string `json:"error,omitempty"`
}

type ToolEntry struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	McpServerID string          `json:"mcpServerId,omitempty"`
	Source      string          `json:"source,omitempty"`
	Enabled     *bool           `json:"enabled,omitempty"`
	Active      *bool           `json:"active,omitempty"`
	Loaded      *bool           `json:"loaded,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

// InventoryResult is "ok" (Scope, ObservedAt, View, Items, Partial),
// "unsupported" (Code, Reason) or "unavailable" (Code, Reason).
type InventoryResult[T any] struct {
	Kind       string
	Scope      InventoryScope
	ObservedAt string
	// "discovered" | "context" | "registered" | "mcp-only"
	View    string
	Items   []T
	Partial bool
	Code    string
	Reason  string
}

func (r InventoryResult[T]) MarshalJSON() ([]byte, error) {
	o := newObject()
	_ = o.field("kind", r.Kind)
	if r.Kind == "ok" {
		_ = o.field("scope", r.Scope)
		_ = o.field("observedAt", r.ObservedAt)
		_ = o.field("view", r.View)
		_ = o.field("items", nonNil(r.Items))
		_ = o.field("partial", r.Partial)
		return o.bytes(), nil
	}
	_ = o.field("code", r.Code)
	_ = o.field("reason", r.Reason)
	return o.bytes(), nil
}

type InventoryReader[T any] func(ctx context.Context, installation AvailableInstallation, options InventoryOptions) (InventoryResult[T], error)

func nonNil[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

// ─── Registry ──────────────────────────────────────────────────────────────

// RuntimeRegistry is a runtime collection with lookup by id.
type RuntimeRegistry struct {
	order []string
	byID  map[string]Runtime
}

// NewRuntimeRegistry indexes runtimes; a duplicate id is an error.
func NewRuntimeRegistry(runtimes ...Runtime) (*RuntimeRegistry, error) {
	registry := &RuntimeRegistry{byID: map[string]Runtime{}}
	for _, runtime := range runtimes {
		if _, ok := registry.byID[runtime.ID]; ok {
			return nil, fmt.Errorf("duplicate runtime id: %s", runtime.ID)
		}
		registry.byID[runtime.ID] = runtime
		registry.order = append(registry.order, runtime.ID)
	}
	return registry, nil
}

// Get finds a runtime.
func (r *RuntimeRegistry) Get(id string) (Runtime, bool) {
	runtime, ok := r.byID[id]
	return runtime, ok
}

// Require finds a runtime or errors.
func (r *RuntimeRegistry) Require(id string) (Runtime, error) {
	runtime, ok := r.byID[id]
	if !ok {
		return Runtime{}, fmt.Errorf("unknown runtime: %s", id)
	}
	return runtime, nil
}

// List returns the runtimes in registration order.
func (r *RuntimeRegistry) List() []Runtime {
	out := make([]Runtime, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, r.byID[id])
	}
	return out
}
