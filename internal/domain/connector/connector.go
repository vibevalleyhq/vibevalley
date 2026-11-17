package connector

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const connectorsFileName = "connectors.json"

// ConnectorID identifies a supported external IM platform.
type ConnectorID string

const (
	ConnectorWeixin   ConnectorID = "weixin"
	ConnectorFeishu   ConnectorID = "feishu"
	ConnectorQQ       ConnectorID = "qq"
	ConnectorTelegram ConnectorID = "telegram"
	ConnectorDiscord  ConnectorID = "discord"
	ConnectorSlack    ConnectorID = "slack"
)

// DefaultConnectors defines the built-in IM connectors exposed by VibeValley.
var DefaultConnectors = []ConnectorID{
	ConnectorWeixin,
	ConnectorFeishu,
	ConnectorQQ,
	ConnectorTelegram,
	ConnectorDiscord,
	ConnectorSlack,
}

// ConnectorState tracks the lifecycle state of a connector.
type ConnectorState string

const (
	StateOff       ConnectorState = "off"
	StateWaiting   ConnectorState = "waiting"
	StateScanned   ConnectorState = "scanned"
	StateVerify    ConnectorState = "verify"
	StatePairing   ConnectorState = "pairing"
	StateConnected ConnectorState = "connected"
	StatePaused    ConnectorState = "paused"
)

var (
	// ErrConnectorRefused indicates an invalid connector ID, channel, login, or verification failure.
	ErrConnectorRefused = errors.New("connector: refused")
)

// ConnectorStatus matches packages/protocol/src/connector/shapes.ts ConnectorStatus.
type ConnectorStatus struct {
	ID          ConnectorID    `json:"id"`
	State       ConnectorState `json:"state"`
	QR          string         `json:"qr"`
	PairCode    string         `json:"pairCode"`
	Channel     string         `json:"channel,omitempty"`
	User        string         `json:"user,omitempty"`
	Since       *int64         `json:"since,omitempty"`
	LastInbound *int64         `json:"lastInbound,omitempty"`
	PausedUntil *int64         `json:"pausedUntil,omitempty"`
	Pending     int            `json:"pending"`
	Error       string         `json:"error"`
}

// ConnectorLogin carries login credentials or force-relogin options.
type ConnectorLogin struct {
	Force    bool   `json:"force,omitempty"`
	AppID    string `json:"appId,omitempty"`
	Secret   string `json:"secret,omitempty"`
	BotToken string `json:"botToken,omitempty"`
	Domain   string `json:"domain,omitempty"`
}

// LoginOutcome is returned by Adapter.Login and Adapter.Verify.
type LoginOutcome struct {
	State   ConnectorState
	QR      string
	User    string
	Secrets map[string]string
}

// Adapter abstracts external IM platform login, verification, and outbound delivery.
type Adapter interface {
	ID() ConnectorID
	Login(ctx context.Context, input ConnectorLogin) (LoginOutcome, error)
	Verify(ctx context.Context, secrets map[string]string, code string) (LoginOutcome, error)
	Send(ctx context.Context, secrets map[string]string, to, text, replyCtx string) (string, error)
}

// ChannelValidator resolves and validates a target channel name during SetChannel.
type ChannelValidator func(ctx context.Context, name string) (resolvedChannel string, isDefault bool, err error)

// Options configures a Connector Service.
type Options struct {
	HomeDir          string
	Clock            store.Clock
	HTTPClient       *http.Client
	Adapters         []Adapter
	ChannelValidator ChannelValidator
	OnChange         func(ConnectorStatus)
}

type storedAccount struct {
	ID          ConnectorID       `json:"id"`
	State       ConnectorState    `json:"state"`
	QR          string            `json:"qr,omitempty"`
	PairCode    string            `json:"pairCode,omitempty"`
	Channel     string            `json:"channel,omitempty"`
	User        string            `json:"user,omitempty"`
	Since       *int64            `json:"since,omitempty"`
	LastInbound *int64            `json:"lastInbound,omitempty"`
	PausedUntil *int64            `json:"pausedUntil,omitempty"`
	Pending     int               `json:"pending,omitempty"`
	Error       string            `json:"error,omitempty"`
	Secrets     map[string]string `json:"secrets,omitempty"`
}

type persistedConnectors struct {
	Accounts map[ConnectorID]storedAccount `json:"accounts"`
}

// Service manages external IM connector lifecycles, channels, and persisted credentials.
type Service struct {
	homeDir          string
	filePath         string
	clock            store.Clock
	httpClient       *http.Client
	channelValidator ChannelValidator
	onChange         func(ConnectorStatus)

	mu       sync.RWMutex
	order    []ConnectorID
	adapters map[ConnectorID]Adapter
	accounts map[ConnectorID]storedAccount
}

// NewService constructs a Connector Service, reloading $VIBEVALLEY_HOME/connectors.json when homeDir is set.
func NewService(opts Options) (*Service, error) {
	clk := opts.Clock
	if clk == nil {
		clk = store.RealClock{}
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	adapters := make(map[ConnectorID]Adapter)
	var order []ConnectorID
	for _, id := range DefaultConnectors {
		adapters[id] = newBuiltinAdapter(id, httpClient)
		order = append(order, id)
	}
	for _, a := range opts.Adapters {
		if a == nil || a.ID() == "" {
			continue
		}
		id := a.ID()
		if _, exists := adapters[id]; !exists {
			order = append(order, id)
		}
		adapters[id] = a
	}

	s := &Service{
		homeDir:          strings.TrimSpace(opts.HomeDir),
		clock:            clk,
		httpClient:       httpClient,
		channelValidator: opts.ChannelValidator,
		onChange:         opts.OnChange,
		order:            order,
		adapters:         adapters,
		accounts:         make(map[ConnectorID]storedAccount),
	}
	if s.homeDir != "" {
		s.filePath = filepath.Join(s.homeDir, connectorsFileName)
		if err := s.loadFromDisk(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// FilePath returns the path to connectors.json, or "" in memory-only mode.
func (s *Service) FilePath() string { return s.filePath }

// List returns the status of all configured connectors in stable order.
func (s *Service) List() []ConnectorStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]ConnectorStatus, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, s.statusLocked(id))
	}
	return out
}

// Get returns the current status for connector id.
func (s *Service) Get(id ConnectorID) (ConnectorStatus, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.adapters[id]; !ok {
		return ConnectorStatus{}, fmt.Errorf("%w: unknown connector %q", ErrConnectorRefused, id)
	}
	return s.statusLocked(id), nil
}

// Login starts or configures an IM connector login flow and persists the resulting state.
func (s *Service) Login(ctx context.Context, id ConnectorID, input ConnectorLogin) (ConnectorStatus, error) {
	if err := ctx.Err(); err != nil {
		return ConnectorStatus{}, err
	}
	s.mu.RLock()
	adapter, ok := s.adapters[id]
	existing, hasExisting := s.accounts[id]
	s.mu.RUnlock()
	if !ok {
		return ConnectorStatus{}, fmt.Errorf("%w: unknown connector %q", ErrConnectorRefused, id)
	}

	if hasExisting && !input.Force && (existing.State == StateWaiting || existing.State == StateVerify || existing.State == StateScanned) {
		return toPublicStatus(existing), nil
	}

	outcome, err := adapter.Login(ctx, input)
	if err != nil {
		s.mu.Lock()
		acc := s.accounts[id]
		acc.ID = id
		if acc.State == "" {
			acc.State = StateOff
		}
		acc.Error = err.Error()
		s.accounts[id] = acc
		_ = s.persistLocked()
		st := toPublicStatus(acc)
		s.mu.Unlock()
		s.emitChange(st)
		return st, fmt.Errorf("%w: %v", ErrConnectorRefused, err)
	}

	return s.applyOutcome(id, outcome, existing.Channel)
}

// Verify submits a verification or pairing code for connector id.
func (s *Service) Verify(ctx context.Context, id ConnectorID, code string) (ConnectorStatus, error) {
	if err := ctx.Err(); err != nil {
		return ConnectorStatus{}, err
	}
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return ConnectorStatus{}, fmt.Errorf("%w: verification code is required", ErrConnectorRefused)
	}

	s.mu.RLock()
	adapter, ok := s.adapters[id]
	existing, hasExisting := s.accounts[id]
	s.mu.RUnlock()
	if !ok {
		return ConnectorStatus{}, fmt.Errorf("%w: unknown connector %q", ErrConnectorRefused, id)
	}
	if !hasExisting || existing.State == StateOff {
		return ConnectorStatus{}, fmt.Errorf("%w: connector %q is not signing in", ErrConnectorRefused, id)
	}

	// If waiting for IM pairing code, validate directly against PairCode.
	if existing.State == StatePairing && existing.PairCode != "" {
		if len(trimmed) != len(existing.PairCode) || subtle.ConstantTimeCompare([]byte(trimmed), []byte(existing.PairCode)) != 1 {
			return ConnectorStatus{}, fmt.Errorf("%w: invalid pairing code", ErrConnectorRefused)
		}
		now := s.clock.NowMs()
		s.mu.Lock()
		acc := s.accounts[id]
		acc.State = StateConnected
		acc.PairCode = ""
		if acc.User == "" {
			acc.User = "paired-user"
		}
		if acc.Since == nil {
			acc.Since = &now
		}
		acc.Error = ""
		s.accounts[id] = acc
		if err := s.persistLocked(); err != nil {
			s.mu.Unlock()
			return ConnectorStatus{}, err
		}
		st := toPublicStatus(acc)
		s.mu.Unlock()
		s.emitChange(st)
		return st, nil
	}

	outcome, err := adapter.Verify(ctx, cloneStringMap(existing.Secrets), trimmed)
	if err != nil {
		return ConnectorStatus{}, fmt.Errorf("%w: %v", ErrConnectorRefused, err)
	}
	return s.applyOutcome(id, outcome, existing.Channel)
}

// Logout disconnects connector id, clears persisted credentials/secrets, and resets state to "off".
func (s *Service) Logout(ctx context.Context, id ConnectorID) (ConnectorStatus, error) {
	if err := ctx.Err(); err != nil {
		return ConnectorStatus{}, err
	}
	s.mu.Lock()
	if _, ok := s.adapters[id]; !ok {
		s.mu.Unlock()
		return ConnectorStatus{}, fmt.Errorf("%w: unknown connector %q", ErrConnectorRefused, id)
	}
	delete(s.accounts, id)
	if err := s.persistLocked(); err != nil {
		s.mu.Unlock()
		return ConnectorStatus{}, err
	}
	st := offStatus(id)
	s.mu.Unlock()
	s.emitChange(st)
	return st, nil
}

// SetChannel binds connector id to the named channel (or clears back to default channel when name == "").
func (s *Service) SetChannel(ctx context.Context, id ConnectorID, channelName string) (ConnectorStatus, error) {
	if err := ctx.Err(); err != nil {
		return ConnectorStatus{}, err
	}
	s.mu.RLock()
	_, ok := s.adapters[id]
	validator := s.channelValidator
	s.mu.RUnlock()
	if !ok {
		return ConnectorStatus{}, fmt.Errorf("%w: unknown connector %q", ErrConnectorRefused, id)
	}

	resolved := strings.TrimSpace(channelName)
	if validator != nil {
		var isDefault bool
		var err error
		resolved, isDefault, err = validator(ctx, resolved)
		if err != nil {
			return ConnectorStatus{}, fmt.Errorf("%w: %v", ErrConnectorRefused, err)
		}
		if isDefault {
			resolved = ""
		}
	}

	s.mu.Lock()
	acc, exists := s.accounts[id]
	if !exists {
		acc = storedAccount{ID: id, State: StateOff}
	}
	acc.Channel = resolved
	s.accounts[id] = acc
	if err := s.persistLocked(); err != nil {
		s.mu.Unlock()
		return ConnectorStatus{}, err
	}
	st := toPublicStatus(acc)
	s.mu.Unlock()
	s.emitChange(st)
	return st, nil
}

// Send dispatches an outbound text message through connector id using its persisted credentials.
func (s *Service) Send(ctx context.Context, id ConnectorID, to, text, replyCtx string) (string, error) {
	s.mu.RLock()
	adapter, ok := s.adapters[id]
	acc, hasAcc := s.accounts[id]
	s.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("%w: unknown connector %q", ErrConnectorRefused, id)
	}
	if !hasAcc || acc.State != StateConnected {
		return "", fmt.Errorf("%w: connector %q is not connected", ErrConnectorRefused, id)
	}
	target := strings.TrimSpace(to)
	if target == "" {
		target = acc.User
	}
	return adapter.Send(ctx, cloneStringMap(acc.Secrets), target, text, replyCtx)
}

func (s *Service) applyOutcome(id ConnectorID, outcome LoginOutcome, existingChannel string) (ConnectorStatus, error) {
	now := s.clock.NowMs()
	state := outcome.State
	var pairCode string

	switch state {
	case StateWaiting, StateScanned, StateVerify:
	case StatePairing, StateConnected:
		if outcome.User == "" && state == StateConnected {
			state = StatePairing
		}
		if state == StatePairing {
			code, err := generate6DigitPairCode()
			if err != nil {
				return ConnectorStatus{}, err
			}
			pairCode = code
		}
	case "":
		if outcome.User != "" {
			state = StateConnected
		} else {
			code, err := generate6DigitPairCode()
			if err != nil {
				return ConnectorStatus{}, err
			}
			state = StatePairing
			pairCode = code
		}
	default:
		return ConnectorStatus{}, fmt.Errorf("%w: unexpected login state %q", ErrConnectorRefused, state)
	}

	s.mu.Lock()
	acc := storedAccount{
		ID:       id,
		State:    state,
		QR:       outcome.QR,
		PairCode: pairCode,
		Channel:  existingChannel,
		User:     shortUserDisplay(outcome.User),
		Secrets:  cloneStringMap(outcome.Secrets),
	}
	if state == StateConnected || state == StatePairing {
		acc.Since = &now
	}
	s.accounts[id] = acc
	if err := s.persistLocked(); err != nil {
		s.mu.Unlock()
		return ConnectorStatus{}, err
	}
	st := toPublicStatus(acc)
	s.mu.Unlock()
	s.emitChange(st)
	return st, nil
}

func (s *Service) statusLocked(id ConnectorID) ConnectorStatus {
	if acc, ok := s.accounts[id]; ok {
		return toPublicStatus(acc)
	}
	return offStatus(id)
}

func offStatus(id ConnectorID) ConnectorStatus {
	return ConnectorStatus{
		ID:    id,
		State: StateOff,
	}
}

func toPublicStatus(acc storedAccount) ConnectorStatus {
	return ConnectorStatus{
		ID:          acc.ID,
		State:       acc.State,
		QR:          acc.QR,
		PairCode:    acc.PairCode,
		Channel:     acc.Channel,
		User:        acc.User,
		Since:       cloneInt64Ptr(acc.Since),
		LastInbound: cloneInt64Ptr(acc.LastInbound),
		PausedUntil: cloneInt64Ptr(acc.PausedUntil),
		Pending:     acc.Pending,
		Error:       acc.Error,
	}
}

func (s *Service) emitChange(st ConnectorStatus) {
	if s.onChange != nil {
		s.onChange(st)
	}
}

func (s *Service) loadFromDisk() error {
	raw, err := os.ReadFile(s.filePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", s.filePath, err)
	}
	var doc persistedConnectors
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("decode %s: %w", s.filePath, err)
	}
	for id, acc := range doc.Accounts {
		if acc.ID == "" {
			acc.ID = id
		}
		if _, ok := s.adapters[id]; !ok {
			s.adapters[id] = newBuiltinAdapter(id, s.httpClient)
			s.order = append(s.order, id)
		}
		s.accounts[id] = acc
	}
	slices.Sort(s.order)
	return nil
}

func (s *Service) persistLocked() error {
	if s.filePath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(persistedConnectors{
		Accounts: s.accounts,
	}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(s.filePath), "."+filepath.Base(s.filePath)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.filePath); err != nil {
		return err
	}
	cleanup = false
	return nil
}

type builtinAdapter struct {
	id         ConnectorID
	httpClient *http.Client
}

func newBuiltinAdapter(id ConnectorID, httpClient *http.Client) Adapter {
	return &builtinAdapter{id: id, httpClient: httpClient}
}

func (a *builtinAdapter) ID() ConnectorID { return a.id }

func (a *builtinAdapter) Login(_ context.Context, input ConnectorLogin) (LoginOutcome, error) {
	appID := strings.TrimSpace(input.AppID)
	secret := strings.TrimSpace(input.Secret)
	botToken := strings.TrimSpace(input.BotToken)
	if botToken == "" && (a.id == ConnectorTelegram || a.id == ConnectorDiscord || a.id == ConnectorSlack) {
		botToken = secret
	}

	switch a.id {
	case ConnectorTelegram, ConnectorDiscord, ConnectorSlack:
		if botToken == "" {
			return LoginOutcome{}, fmt.Errorf("%s bot token or secret is required", a.id)
		}
		return LoginOutcome{
			State: StateConnected,
			User:  string(a.id) + "-bot",
			Secrets: map[string]string{
				"botToken": botToken,
				"appId":    appID,
			},
		}, nil

	case ConnectorQQ:
		if appID == "" || secret == "" {
			return LoginOutcome{}, errors.New("qq requires appId and secret")
		}
		return LoginOutcome{
			State: StatePairing,
			Secrets: map[string]string{
				"appId":  appID,
				"secret": secret,
			},
		}, nil

	case ConnectorFeishu:
		if appID != "" && secret != "" {
			domain := strings.TrimSpace(input.Domain)
			if domain == "" {
				domain = "feishu"
			}
			return LoginOutcome{
				State: StatePairing,
				Secrets: map[string]string{
					"appId":     appID,
					"appSecret": secret,
					"domain":    domain,
				},
			}, nil
		}
		return LoginOutcome{
			State:   StateWaiting,
			QR:      fmt.Sprintf("https://open.feishu.cn/page/cli?connector=%s", a.id),
			Secrets: map[string]string{},
		}, nil

	case ConnectorWeixin:
		if botToken != "" {
			return LoginOutcome{
				State: StateConnected,
				User:  "wx-user",
				Secrets: map[string]string{
					"botToken": botToken,
				},
			}, nil
		}
		return LoginOutcome{
			State:   StateWaiting,
			QR:      "https://liteapp.weixin.qq.com/q/vibevalley",
			Secrets: map[string]string{},
		}, nil

	default:
		if appID == "" && secret == "" && botToken == "" {
			return LoginOutcome{
				State:   StateWaiting,
				QR:      fmt.Sprintf("vibevalley://connector/%s/login", a.id),
				Secrets: map[string]string{},
			}, nil
		}
		return LoginOutcome{
			State: StateConnected,
			User:  string(a.id) + "-account",
			Secrets: map[string]string{
				"appId":    appID,
				"secret":   secret,
				"botToken": botToken,
			},
		}, nil
	}
}

func (a *builtinAdapter) Verify(_ context.Context, secrets map[string]string, code string) (LoginOutcome, error) {
	if strings.TrimSpace(code) == "" {
		return LoginOutcome{}, errors.New("verification code cannot be empty")
	}
	nextSecrets := cloneStringMap(secrets)
	nextSecrets["verifiedCode"] = code
	return LoginOutcome{
		State:   StateConnected,
		User:    string(a.id) + "-verified",
		Secrets: nextSecrets,
	}, nil
}

func (a *builtinAdapter) Send(_ context.Context, secrets map[string]string, to, text, _ string) (string, error) {
	if len(secrets) == 0 {
		return "", errors.New("connector has no credentials")
	}
	if strings.TrimSpace(text) == "" {
		return "", errors.New("message text is empty")
	}
	return fmt.Sprintf("%s:%s", a.id, to), nil
}

func generate6DigitPairCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(900_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", 100_000+n.Int64()), nil
}

func shortUserDisplay(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len([]rune(trimmed)) <= 24 {
		return trimmed
	}
	runes := []rune(trimmed)
	return string(runes[:24])
}

func cloneStringMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func cloneInt64Ptr(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
