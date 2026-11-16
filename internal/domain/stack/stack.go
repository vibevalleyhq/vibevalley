package stack

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/game"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	domainwatch "github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var (
	// ErrClosed is returned after Stack.Close has been called.
	ErrClosed = errors.New("stack: closed")
	// ErrInvalidConfig is returned when required configuration is invalid.
	ErrInvalidConfig = errors.New("stack: invalid configuration")
)

// Config configures an assembled VibeValley runtime stack.
type Config struct {
	// DBPath is ":memory:" (default) for ephemeral runs or a SQLite WAL path for durable persistence.
	// Sidecar WAL databases for independent module pools derive from DBPath to avoid SQLITE_BUSY.
	DBPath string

	// WorkRoot is the root directory used for repo/worktree clones and local state fallback.
	// When empty for ephemeral runs, a temporary directory is provisioned and removed on Close.
	WorkRoot    string
	ArtifactDir string
	MediaDir    string
	ServerURL   string

	// Security & governance configuration.
	VaultRootKey            *vault.RootKey
	VaultSigningKey         *vault.SigningKey
	AllowLoopbackEgress     bool
	EgressIPPolicy          *vault.IPPolicyOptions
	EgressRequireHTTPS      bool
	EgressUpstreamTransport http.RoundTripper
	PermissionConfig        *durable.PermissionConfig
	RiskClassifier          durable.RiskClassifier

	// Execution & grading collaborators (optional defaults applied when nil).
	Clock             store.Clock
	Model             durable.ModelClient
	Tools             durable.ToolExecutor
	CodeTool          durable.CodeToolFunc
	Summarizer        durable.Summarizer
	GraderDriver      durable.GraderDriver
	PRChecker         issue.PRChecker
	Deliverables      durable.DeliverablesFunc
	DreamConsolidator memory.DreamConsolidator
	BrakeConfig       *domainwatch.BrakeConfig

	// Artifact & media settings.
	MaxDeliverableBytes int64
	MaxAssetBytes       int64
	PreviewHost         string
	WorkbenchHosts      []string
	AllowWorkbenchEmbed bool

	// Link & alert callbacks.
	LinkAuthenticator link.Authenticator
	AlertHandler      func(durable.Alert)
	OnChannelWake     func(ctx context.Context, req domainwatch.DispatchRequest, sub store.Submission) error
	OnIssueDispatch   func(ctx context.Context, cmd issue.DispatchCommand, sub store.Submission) error
	DisableIssueAuto  bool
}

// Stack wires all VibeValley infrastructure and domain modules into a runnable platform runtime.
type Stack struct {
	cfg        Config
	clock      store.Clock
	ownsWork   bool
	workRoot   string
	serverURL  string
	bgCtx      context.Context
	bgCancel   context.CancelFunc
	wg         sync.WaitGroup
	closeOnce  sync.Once
	closed     atomic.Bool
	unsubDoc   func()
	unsubIssue func()

	Store       *store.Store
	Scheduler   *durable.Scheduler
	Leases      *durable.LeaseStore
	Budget      *durable.BudgetGate
	Permissions *durable.PermissionEvaluator
	Grader      *durable.OutcomeGrader
	Compactor   *durable.Compactor

	VaultDB *sql.DB
	Vault   *vault.Store
	Tokens  *vault.TokenService
	Egress  *vault.EgressProxy

	Channels *channel.Store
	Watch    *domainwatch.Service
	Issues   *issue.Service
	Agents   *agent.Registry
	Repos    *repo.Registry
	PKM      *pkm.Store
	Memory   *memory.Store

	Artifacts *artifact.Service
	Media     *media.Store
	Game      *game.Projector
	Ledger    *game.Ledger
	Machines  *MachineHub

	model      durable.ModelClient
	tools      durable.ToolExecutor
	customDelv durable.DeliverablesFunc

	alertMu   sync.RWMutex
	alertSubs map[uint64]func(durable.Alert)
	alertSeq  atomic.Uint64

	clientLinksMu sync.Mutex
	clientLinks   map[*link.Link]struct{}

	urlMu sync.RWMutex
}

// New constructs, wires, and starts all domain modules, durable scheduler phases,
// vault egress proxy, machine hub, and reactive game projector.
func New(ctx context.Context, cfg Config) (*Stack, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	clk := cfg.Clock
	if clk == nil {
		clk = store.RealClock{}
	}

	dbPath := strings.TrimSpace(cfg.DBPath)
	if dbPath == "" {
		dbPath = ":memory:"
	}
	isMem := dbPath == ":memory:"

	workRoot := strings.TrimSpace(cfg.WorkRoot)
	var ownsWork bool
	if workRoot == "" {
		dir, err := os.MkdirTemp("", "vibevalley-stack-*")
		if err != nil {
			return nil, fmt.Errorf("stack: temp work root: %w", err)
		}
		workRoot = dir
		ownsWork = true
	} else if err := os.MkdirAll(workRoot, 0o755); err != nil {
		return nil, fmt.Errorf("stack: mkdir work root: %w", err)
	}

	bgCtx, bgCancel := context.WithCancel(context.Background())
	s := &Stack{
		cfg:         cfg,
		clock:       clk,
		ownsWork:    ownsWork,
		workRoot:    workRoot,
		serverURL:   strings.TrimSpace(cfg.ServerURL),
		bgCtx:       bgCtx,
		bgCancel:    bgCancel,
		customDelv:  cfg.Deliverables,
		alertSubs:   make(map[uint64]func(durable.Alert)),
		clientLinks: make(map[*link.Link]struct{}),
	}

	cleanupOnErr := true
	defer func() {
		if cleanupOnErr {
			_ = s.Close()
		}
	}()

	// Game reactive SpaceView projector & progression ledger.
	proj, err := game.NewProjector()
	if err != nil {
		return nil, fmt.Errorf("stack: game projector: %w", err)
	}
	s.Game = proj

	if isMem {
		s.Ledger = game.NewMemoryLedger()
	} else {
		if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
			return nil, fmt.Errorf("stack: mkdir db dir: %w", err)
		}
		ledger, err := game.OpenSQLiteLedger(ctx, sidecarDBPath(dbPath, "game"))
		if err != nil {
			return nil, fmt.Errorf("stack: open ledger: %w", err)
		}
		s.Ledger = ledger
	}

	// Durable store + scheduler + governance modules.
	if isMem {
		s.Store = store.NewMemory(store.WithClock(clk))
	} else {
		st, err := store.OpenSQLite(ctx, dbPath, store.WithClock(clk))
		if err != nil {
			return nil, fmt.Errorf("stack: open durable sqlite: %w", err)
		}
		s.Store = st
	}
	s.unsubDoc = s.Store.SubscribeDocuments(s.Game)

	alertSink := durable.AlertSinkFunc(s.dispatchAlert)
	s.Scheduler = durable.NewScheduler(s.Store, durable.WithAlertSink(alertSink))
	s.Leases = durable.NewLeaseStore()
	s.Budget = durable.NewBudgetGate(s.Store, s.Leases, alertSink)

	permCfg := durable.DefaultPermissionConfig()
	if cfg.PermissionConfig != nil {
		permCfg = *cfg.PermissionConfig
	}
	classifier := cfg.RiskClassifier
	if classifier == nil {
		classifier = durable.DefaultRiskClassifier{}
	}
	s.Permissions = durable.NewPermissionEvaluator(s.Store, permCfg, classifier, alertSink)

	graderDriver := cfg.GraderDriver
	if graderDriver == nil {
		graderDriver = durable.GraderDriverFunc(defaultPassGrader)
	}
	s.Grader = durable.NewOutcomeGrader(s.Store, graderDriver)
	s.Compactor = durable.NewCompactor(s.Store, cfg.Summarizer, durable.DefaultCompactionThresholds())

	// Vault root key, key ring, secret store, short-lived capability tokens, and egress proxy.
	var rk vault.RootKey
	if cfg.VaultRootKey != nil {
		rk = *cfg.VaultRootKey
	} else {
		rk, err = vault.GenerateRootKey("stack-root")
		if err != nil {
			return nil, fmt.Errorf("stack: generate root key: %w", err)
		}
	}
	kr, err := vault.NewKeyRing(rk)
	if err != nil {
		return nil, fmt.Errorf("stack: vault keyring: %w", err)
	}

	var vBackend vault.Backend
	if isMem {
		vBackend = vault.NewMemoryBackend()
	} else {
		vPath := sidecarDBPath(dbPath, "vault")
		vDB, err := sql.Open("sqlite", vPath)
		if err != nil {
			return nil, fmt.Errorf("stack: open vault db: %w", err)
		}
		vDB.SetMaxOpenConns(1)
		if _, err := vDB.ExecContext(ctx, `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;`); err != nil {
			_ = vDB.Close()
			return nil, fmt.Errorf("stack: vault pragmas: %w", err)
		}
		s.VaultDB = vDB
		sb, err := vault.NewSQLBackend(vDB, vault.DialectSQLite)
		if err != nil {
			return nil, fmt.Errorf("stack: vault sql backend: %w", err)
		}
		if err := sb.EnsureSchema(ctx); err != nil {
			return nil, fmt.Errorf("stack: vault schema: %w", err)
		}
		vBackend = sb
	}
	s.Vault, err = vault.NewStore(kr, vBackend, vault.WithStoreClock(clk.Now))
	if err != nil {
		return nil, fmt.Errorf("stack: vault store: %w", err)
	}

	var sk vault.SigningKey
	if cfg.VaultSigningKey != nil {
		sk = *cfg.VaultSigningKey
	} else {
		sk, err = vault.GenerateSigningKey("stack-cap-sign")
		if err != nil {
			return nil, fmt.Errorf("stack: generate signing key: %w", err)
		}
	}
	s.Tokens, err = vault.NewTokenService(sk, vault.WithTokenClock(clk.Now))
	if err != nil {
		return nil, fmt.Errorf("stack: token service: %w", err)
	}

	egressOpts := []vault.OutboundOption{
		vault.WithAllowLoopback(cfg.AllowLoopbackEgress),
		vault.WithRequireHTTPS(cfg.EgressRequireHTTPS),
		vault.WithEgressClock(clk.Now),
	}
	if cfg.EgressIPPolicy != nil {
		egressOpts = append(egressOpts, vault.WithIPPolicy(*cfg.EgressIPPolicy))
	}
	if cfg.EgressUpstreamTransport != nil {
		egressOpts = append(egressOpts, vault.WithUpstreamTransport(cfg.EgressUpstreamTransport))
	}
	s.Egress, err = vault.NewEgressProxy(s.Vault, s.Tokens, egressOpts...)
	if err != nil {
		return nil, fmt.Errorf("stack: egress proxy: %w", err)
	}

	// Artifacts & Media stores.
	artDir := strings.TrimSpace(cfg.ArtifactDir)
	if artDir == "" && !isMem {
		artDir = filepath.Join(filepath.Dir(dbPath), "artifacts")
	}
	s.Artifacts, err = artifact.NewService(artifact.ServiceConfig{
		Dir:                 artDir,
		Now:                 clk.NowMs,
		MaxDeliverableBytes: cfg.MaxDeliverableBytes,
		PreviewHost:         cfg.PreviewHost,
		WorkbenchHosts:      cfg.WorkbenchHosts,
		AllowWorkbenchEmbed: cfg.AllowWorkbenchEmbed,
	})
	if err != nil {
		return nil, fmt.Errorf("stack: artifact service: %w", err)
	}

	mediaDir := strings.TrimSpace(cfg.MediaDir)
	if mediaDir == "" && !isMem {
		mediaDir = filepath.Join(filepath.Dir(dbPath), "media")
	}
	s.Media, err = media.NewStore(media.Config{
		Dir:           mediaDir,
		MaxAssetBytes: cfg.MaxAssetBytes,
		Now:           clk.NowMs,
	})
	if err != nil {
		return nil, fmt.Errorf("stack: media store: %w", err)
	}

	// Agents, Repositories, PKM, and Memory domain stores.
	if isMem {
		s.Agents = agent.NewMemoryRegistry(agent.WithClock(clk))
		s.Repos = repo.NewMemoryRegistry(repo.WithClock(clk), repo.WithWorkRoot(workRoot))
		s.PKM, err = pkm.OpenStore(ctx, ":memory:")
		if err != nil {
			return nil, fmt.Errorf("stack: open pkm memory store: %w", err)
		}
		s.Memory, err = memory.OpenStore(ctx, ":memory:", memory.WithClock(clk.NowMs))
		if err != nil {
			return nil, fmt.Errorf("stack: open memory store: %w", err)
		}
	} else {
		s.Agents, err = agent.OpenSQLiteRegistry(ctx, sidecarDBPath(dbPath, "agent"), agent.WithClock(clk))
		if err != nil {
			return nil, fmt.Errorf("stack: open agent sqlite: %w", err)
		}
		s.Repos, err = repo.OpenSQLiteRegistry(ctx, sidecarDBPath(dbPath, "repo"), repo.WithClock(clk), repo.WithWorkRoot(workRoot))
		if err != nil {
			return nil, fmt.Errorf("stack: open repo sqlite: %w", err)
		}
		s.PKM, err = pkm.OpenStore(ctx, sidecarDBPath(dbPath, "pkm"))
		if err != nil {
			return nil, fmt.Errorf("stack: open pkm sqlite: %w", err)
		}
		s.Memory, err = memory.OpenStore(ctx, sidecarDBPath(dbPath, "memory"), memory.WithClock(clk.NowMs))
		if err != nil {
			return nil, fmt.Errorf("stack: open memory sqlite: %w", err)
		}
	}

	// Collaboration: Channels, Watch (with durable idempotent dispatcher), and Issues.
	if isMem {
		s.Channels = channel.NewMemoryStore(channel.WithClock(clk))
	} else {
		s.Channels, err = channel.OpenSQLite(ctx, sidecarDBPath(dbPath, "channel"), channel.WithClock(clk))
		if err != nil {
			return nil, fmt.Errorf("stack: open channel sqlite: %w", err)
		}
	}

	watchDispatcher := &domainwatch.DurableDispatcher{
		Store:        s.Store,
		OnDispatched: cfg.OnChannelWake,
	}
	watchOpts := []domainwatch.Option{
		domainwatch.WithClock(clk),
		domainwatch.WithDispatcher(watchDispatcher),
	}
	if cfg.BrakeConfig != nil {
		watchOpts = append(watchOpts, domainwatch.WithBrakeConfig(*cfg.BrakeConfig))
	}
	if isMem {
		s.Watch = domainwatch.NewMemoryService(s.Channels, watchOpts...)
	} else {
		s.Watch, err = domainwatch.OpenSQLiteService(ctx, s.Channels, sidecarDBPath(dbPath, "watch"), watchOpts...)
		if err != nil {
			return nil, fmt.Errorf("stack: open watch sqlite: %w", err)
		}
	}

	issueSink := &issue.DurableDispatchSink{
		Store:        s.Store,
		OnDispatched: s.onIssueDispatched,
	}
	issueOpts := []issue.Option{
		issue.WithClock(clk),
		issue.WithDispatchSink(issueSink),
		issue.WithOutcomeGrader(s.Grader),
	}
	if cfg.PRChecker != nil {
		issueOpts = append(issueOpts, issue.WithPRChecker(cfg.PRChecker))
	}
	if isMem {
		s.Issues = issue.NewMemoryService(issueOpts...)
	} else {
		s.Issues, err = issue.OpenSQLiteService(ctx, sidecarDBPath(dbPath, "issue"), issueOpts...)
		if err != nil {
			return nil, fmt.Errorf("stack: open issue sqlite: %w", err)
		}
	}

	// Register durable task phases (generation, codemode, issue.watch).
	s.model = cfg.Model
	if s.model == nil {
		s.model = defaultModelClient{}
	}
	s.tools = s.wrapToolExecutor(cfg.Tools)
	codeTool := cfg.CodeTool
	if codeTool == nil {
		codeTool = defaultCodeTool
	}
	durable.RegisterGenerationPhases(s.Scheduler, durable.GenerationDeps{
		Store:        s.Store,
		Model:        s.model,
		Tools:        s.tools,
		Compactor:    s.Compactor,
		Budget:       s.Budget,
		Permissions:  s.Permissions,
		Grader:       s.Grader,
		Deliverables: s.Deliverables,
	})
	durable.RegisterCodeModePhases(s.Scheduler, codeTool)
	issue.RegisterIssueWatchPhase(s.Scheduler, s.Issues)

	// Machine Hub for outbound vibe-machine connections.
	s.Machines = newMachineHub(s, cfg.LinkAuthenticator)

	// Start watch background monitor and recover pending durable tasks.
	if err := s.Watch.Start(bgCtx); err != nil {
		return nil, fmt.Errorf("stack: start watch service: %w", err)
	}
	if err := s.Recover(ctx); err != nil {
		return nil, fmt.Errorf("stack: recover state: %w", err)
	}

	cleanupOnErr = false
	return s, nil
}

// Recover resumes runnable durable tasks and synchronizes SpaceView projections from persisted state.
func (s *Stack) Recover(ctx context.Context) error {
	if s.closed.Load() {
		return ErrClosed
	}
	if err := s.Scheduler.Recover(ctx); err != nil {
		return err
	}
	if err := s.SyncSpaceProjection(ctx); err != nil {
		return err
	}
	return nil
}

// Close stops background workers, active machine/client links, watch/scheduler loops, and closes stores cleanly.
func (s *Stack) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		s.closed.Store(true)
		s.bgCancel()
		s.closeAllClientLinks()
		if s.Machines != nil {
			s.Machines.closeAll()
		}
		if s.Watch != nil {
			s.Watch.Stop()
		}
		if s.Scheduler != nil {
			s.Scheduler.Close()
		}
		s.wg.Wait()

		if s.unsubDoc != nil {
			s.unsubDoc()
		}
		if s.unsubIssue != nil {
			s.unsubIssue()
		}
		if s.Watch != nil {
			closeErr = errors.Join(closeErr, s.Watch.Close())
		}
		if s.Issues != nil {
			closeErr = errors.Join(closeErr, s.Issues.Close())
		}
		if s.Channels != nil {
			closeErr = errors.Join(closeErr, s.Channels.Close())
		}
		if s.Agents != nil {
			closeErr = errors.Join(closeErr, s.Agents.Close())
		}
		if s.Repos != nil {
			closeErr = errors.Join(closeErr, s.Repos.Close())
		}
		if s.PKM != nil {
			closeErr = errors.Join(closeErr, s.PKM.Close())
		}
		if s.Memory != nil {
			closeErr = errors.Join(closeErr, s.Memory.Close())
		}
		if s.Ledger != nil {
			closeErr = errors.Join(closeErr, s.Ledger.Close())
		}
		if s.Store != nil {
			closeErr = errors.Join(closeErr, s.Store.Close())
		}
		if s.VaultDB != nil {
			closeErr = errors.Join(closeErr, s.VaultDB.Close())
		}
		if s.ownsWork && s.workRoot != "" {
			closeErr = errors.Join(closeErr, os.RemoveAll(s.workRoot))
		}
	})
	return closeErr
}

// WorkRoot returns the workspace root path configured or provisioned for this stack.
func (s *Stack) WorkRoot() string { return s.workRoot }

// SetServerURL sets the advertised HTTP control-plane URL.
func (s *Stack) SetServerURL(raw string) {
	s.urlMu.Lock()
	s.serverURL = strings.TrimSpace(raw)
	s.urlMu.Unlock()
}

// ServerURL returns the advertised HTTP control-plane URL, if any.
func (s *Stack) ServerURL() string {
	s.urlMu.RLock()
	defer s.urlMu.RUnlock()
	return s.serverURL
}

// SubscribeAlerts registers a listener for scheduler and governance alerts (such as budget_reached or permission_park).
func (s *Stack) SubscribeAlerts(fn func(durable.Alert)) func() {
	if fn == nil {
		return func() {}
	}
	id := s.alertSeq.Add(1)
	s.alertMu.Lock()
	s.alertSubs[id] = fn
	s.alertMu.Unlock()
	return func() {
		s.alertMu.Lock()
		delete(s.alertSubs, id)
		s.alertMu.Unlock()
	}
}

func (s *Stack) dispatchAlert(al durable.Alert) {
	if al.Kind == durable.AlertPermissionPark && s.Game != nil {
		var payload struct {
			ToolCall   durable.ToolCall              `json:"toolCall"`
			Evaluation contract.PermissionEvaluation `json:"evaluation"`
		}
		_ = json.Unmarshal(al.Payload, &payload)
		summary := al.Message
		if summary == "" {
			summary = al.Title
		}
		_, _ = s.Game.UpsertApproval(contract.ApprovalPromptView{
			TaskID:        al.TaskID,
			SessionID:     al.ConversationID,
			ToolName:      payload.ToolCall.ToolName,
			Policy:        payload.Evaluation.Policy,
			Summary:       summary,
			RequestedAtMs: al.CreatedAtMs,
		})
	}
	if s.cfg.AlertHandler != nil {
		s.cfg.AlertHandler(al)
	}
	s.alertMu.RLock()
	subs := make([]func(durable.Alert), 0, len(s.alertSubs))
	for _, fn := range s.alertSubs {
		subs = append(subs, fn)
	}
	s.alertMu.RUnlock()
	for _, fn := range subs {
		fn(al)
	}
}

func (s *Stack) Deliverables(ctx context.Context, conversationID string) (string, error) {
	if s.customDelv != nil {
		return s.customDelv(ctx, conversationID)
	}
	var parts []string
	if s.Artifacts != nil && s.Artifacts.Deliverables != nil {
		for _, c := range s.Artifacts.Deliverables.ListCards(ctx, artifact.DeliverableFilter{}) {
			parts = append(parts, fmt.Sprintf("artifact:%s(%s)", c.Title, c.ID))
		}
	}
	if s.Media != nil {
		for _, c := range s.Media.ListCards(ctx, media.CardFilter{}) {
			parts = append(parts, fmt.Sprintf("media:%s(%s)", c.Title, c.SHA256))
		}
	}
	if len(parts) == 0 {
		return "none", nil
	}
	return strings.Join(parts, ", "), nil
}

// ResolveApproval delivers a user approval or rejection for a parked permission task and removes its SpaceView card.
func (s *Stack) ResolveApproval(ctx context.Context, conversationID, taskID, toolCallID string, approved bool, reason string) error {
	if s.closed.Load() {
		return ErrClosed
	}
	if taskID == "" {
		return fmt.Errorf("%w: taskID required", ErrInvalidConfig)
	}
	if conversationID == "" || toolCallID == "" {
		task, err := s.Store.GetTask(ctx, taskID)
		if err != nil {
			return err
		}
		if conversationID == "" {
			conversationID = task.ConversationID
		}
		if toolCallID == "" && len(task.CheckpointJSON) > 0 {
			var cp durable.GenerationCheckpoint
			if json.Unmarshal(task.CheckpointJSON, &cp) == nil {
				if conversationID == "" {
					conversationID = cp.ConversationID
				}
				if cp.ParkedCall != nil {
					toolCallID = cp.ParkedCall.ID
				}
			}
		}
	}
	if err := s.Permissions.ResolveDecision(ctx, s.Scheduler, conversationID, taskID, durable.PermissionDecision{
		ToolCallID: toolCallID,
		Approved:   approved,
		Reason:     reason,
	}); err != nil {
		return err
	}
	if s.Game != nil {
		_, _ = s.Game.RemoveApproval(taskID)
	}
	return nil
}

// RaiseBudget updates a session budget cap and resumes its paused task if sleeping on budget.updated.
func (s *Stack) RaiseBudget(ctx context.Context, conversationID, taskID string, newMaxCostMicros int64) (contract.BudgetSnapshot, error) {
	if s.closed.Load() {
		return contract.BudgetSnapshot{}, ErrClosed
	}
	if conversationID == "" && taskID != "" {
		if task, err := s.Store.GetTask(ctx, taskID); err == nil {
			conversationID = task.ConversationID
		}
	}
	if conversationID == "" {
		return contract.BudgetSnapshot{}, fmt.Errorf("%w: conversationID required", ErrInvalidConfig)
	}
	if taskID == "" {
		tasks, err := s.Store.ListTasksByConversation(ctx, conversationID)
		if err == nil {
			for _, tk := range tasks {
				if tk.Status == store.TaskSleeping && tk.WaitSignalName == durable.SignalBudgetUpdated {
					taskID = tk.ID
					break
				}
			}
		}
	}
	return s.Budget.UpdateBudgetAndResume(ctx, s.Scheduler, conversationID, taskID, contract.BudgetSpec{
		MaxCostMicros: newMaxCostMicros,
	})
}

func sidecarDBPath(baseDBPath, module string) string {
	ext := filepath.Ext(baseDBPath)
	prefix := strings.TrimSuffix(baseDBPath, ext)
	if ext == "" {
		ext = ".db"
	}
	return prefix + "." + module + ext
}

type noopModelClient struct{}

type defaultModelClient = noopModelClient

func (noopModelClient) Generate(_ context.Context, _ durable.ModelRequest, _ func(string)) (durable.ModelResponse, error) {
	return durable.ModelResponse{Text: "ok"}, nil
}

func defaultCodeTool(_ context.Context, toolName string, _ any) (any, error) {
	return nil, fmt.Errorf("stack: code tool %q not configured", toolName)
}

func defaultPassGrader(_ context.Context, _ string, in durable.GraderInput) (contract.RubricVerdict, error) {
	return contract.RubricVerdict{
		Satisfied: true,
		Summary:   "satisfied",
		Iteration: in.Iteration,
	}, nil
}

func (s *Stack) wrapToolExecutor(base durable.ToolExecutor) durable.ToolExecutor {
	return durable.ToolExecutorFunc(func(ctx context.Context, conversationID string, call durable.ToolCall) (json.RawMessage, error) {
		if call.ToolName == "artifact.publish" && base == nil {
			return s.Artifacts.ExecutePublishTool(ctx, call.ArgsJSON)
		}
		if base == nil {
			return nil, fmt.Errorf("stack: tool %q not registered", call.ToolName)
		}
		res, err := base.Execute(ctx, conversationID, call)
		if err != nil && call.ToolName == "artifact.publish" {
			return s.Artifacts.ExecutePublishTool(ctx, call.ArgsJSON)
		}
		return res, err
	})
}
