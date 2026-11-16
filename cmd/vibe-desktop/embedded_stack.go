//go:build !thin_desktop

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/delta"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/link"
	"github.com/vibevalleyhq/vibevalley/pkg/chord/watch"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func init() {
	RegisterStackLauncher(launchEmbeddedStack)
}

// embeddedStack adapts *stack.Stack to EmbeddedStack for in-process MyGo desktop operation
// with zero listening TCP sockets.
type embeddedStack struct {
	runtime      *stack.Stack
	desktopEnd   *link.PipeTransport
	serverEnd    *link.PipeTransport
	attachCtx    context.Context
	attachCancel context.CancelFunc
	wg           sync.WaitGroup
	closeOnce    sync.Once
	onBudget     func(BudgetAlert)
	budgetMu     sync.RWMutex
	unsubAlerts  func()
}

func launchEmbeddedStack(ctx context.Context, cfg DesktopConfig, rootKey vault.RootKey) (EmbeddedStack, error) {
	// If an external control-plane server URL was explicitly supplied, do not boot an embedded duplicate runtime.
	if strings.TrimSpace(cfg.ServerURL) != "" {
		return nil, nil
	}

	dbPath := ":memory:"
	workRoot := ""
	if !cfg.HeadlessCheck {
		if envDB := strings.TrimSpace(os.Getenv("VIBE_DB_PATH")); envDB != "" {
			dbPath = envDB
		} else if confDir, err := os.UserConfigDir(); err == nil && confDir != "" {
			dbPath = filepath.Join(confDir, "vibevalley", "desktop.db")
		}
		if len(cfg.RepoRoots) > 0 {
			workRoot = cfg.RepoRoots[0]
		}
	} else if len(cfg.RepoRoots) > 0 {
		workRoot = cfg.RepoRoots[0]
	}

	rk := rootKey
	st, err := stack.New(ctx, stack.Config{
		DBPath:       dbPath,
		WorkRoot:     workRoot,
		VaultRootKey: &rk,
		ServerURL:    "chord://embedded",
	})
	if err != nil {
		return nil, err
	}

	return newEmbeddedStackFromRuntime(st), nil
}

func newEmbeddedStackFromRuntime(st *stack.Stack) *embeddedStack {
	desktopEnd, serverEnd := link.NewMemoryPipe()
	attachCtx, attachCancel := context.WithCancel(context.Background())

	es := &embeddedStack{
		runtime:      st,
		desktopEnd:   desktopEnd,
		serverEnd:    serverEnd,
		attachCtx:    attachCtx,
		attachCancel: attachCancel,
	}

	es.unsubAlerts = st.SubscribeAlerts(func(al durable.Alert) {
		if al.Kind != durable.AlertBudgetReached {
			return
		}
		var snap contract.BudgetSnapshot
		_ = json.Unmarshal(al.Payload, &snap)
		alert := BudgetAlert{
			ID:             firstNonEmptyStr(al.ConversationID, al.TaskID, "budget"),
			ConversationID: al.ConversationID,
			TaskID:         al.TaskID,
			Title:          al.Title,
			Snapshot:       snap,
		}
		es.budgetMu.RLock()
		fn := es.onBudget
		es.budgetMu.RUnlock()
		if fn != nil {
			fn(alert)
		}
	})

	es.wg.Add(1)
	go func() {
		defer es.wg.Done()
		_, _ = st.AttachClientLink(attachCtx, serverEnd, link.Options{
			Principal: link.Principal{
				Kind: link.PrincipalUserDevice,
				ID:   "vibe-desktop-embedded",
			},
		})
	}()

	return es
}

func (e *embeddedStack) LinkTransport() link.FrameTransport {
	return e.desktopEnd
}

func (e *embeddedStack) SpaceSource() watch.RawSource {
	if e.runtime == nil || e.runtime.Game == nil {
		return nil
	}
	return e.runtime.Game.Document()
}

func (e *embeddedStack) ResolveApproval(ctx context.Context, prompt contract.ApprovalPromptView, approved bool) error {
	reason := "denied in desktop island"
	if approved {
		reason = "approved in desktop island"
	}
	return e.runtime.ResolveApproval(ctx, prompt.SessionID, prompt.TaskID, "", approved, reason)
}

func (e *embeddedStack) RaiseBudget(ctx context.Context, alert BudgetAlert, newMaxCostMicros int64) error {
	_, err := e.runtime.RaiseBudget(ctx, alert.ConversationID, alert.TaskID, newMaxCostMicros)
	return err
}

func (e *embeddedStack) ServerURL() string {
	if e.runtime == nil {
		return ""
	}
	return e.runtime.ServerURL()
}

func (e *embeddedStack) setBudgetAlertHandler(fn func(BudgetAlert)) {
	e.budgetMu.Lock()
	e.onBudget = fn
	e.budgetMu.Unlock()
}

func (e *embeddedStack) Close() error {
	var closeErr error
	e.closeOnce.Do(func() {
		if e.unsubAlerts != nil {
			e.unsubAlerts()
		}
		e.attachCancel()
		if e.desktopEnd != nil {
			_ = e.desktopEnd.Close()
		}
		if e.serverEnd != nil {
			_ = e.serverEnd.Close()
		}
		if e.runtime != nil {
			closeErr = e.runtime.Close()
		}
		e.wg.Wait()
	})
	return closeErr
}

func attachEmbeddedStackToApp(app *DesktopApp) func() {
	if app == nil || app.Stack == nil {
		return nil
	}
	relayCtx, relayCancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup

	if stTr := app.Stack.LinkTransport(); stTr != nil && app.Bridge != nil {
		brSrv := app.Bridge.ServerTransport()
		wg.Add(2)
		go func() {
			defer wg.Done()
			pumpFrames(relayCtx, brSrv, stTr)
		}()
		go func() {
			defer wg.Done()
			pumpFrames(relayCtx, stTr, brSrv)
		}()
	}

	var spaceHandle watch.RawHandle
	if src := app.Stack.SpaceSource(); src != nil && app.Island != nil {
		var mu sync.Mutex
		var curSnap *delta.Snapshot
		h, err := src.WatchRaw(relayCtx, 0, func(_ context.Context, ev watch.RawEvent) {
			mu.Lock()
			if ev.Snapshot != nil {
				curSnap = ev.Snapshot
			} else if len(ev.Ops) > 0 && curSnap != nil {
				if next, applyErr := curSnap.Apply(ev.Ops...); applyErr == nil {
					curSnap = next
				}
			}
			snap := curSnap
			mu.Unlock()
			if snap == nil {
				return
			}
			b, err := json.Marshal(snap.Value())
			if err != nil {
				return
			}
			var sv contract.SpaceView
			if json.Unmarshal(b, &sv) == nil {
				app.Island.ApplySpace(sv)
			}
		})
		if err == nil {
			spaceHandle = h
		}
	}

	if budgetSrc, ok := app.Stack.(interface{ setBudgetAlertHandler(func(BudgetAlert)) }); ok && app.Island != nil {
		budgetSrc.setBudgetAlertHandler(func(alert BudgetAlert) {
			app.Island.SetBudget(alert)
		})
	}

	return func() {
		relayCancel()
		if spaceHandle != nil {
			spaceHandle.Stop()
		}
		if stTr := app.Stack.LinkTransport(); stTr != nil {
			_ = stTr.Close()
		}
		if app.Bridge != nil {
			_ = app.Bridge.Close()
		}
		wg.Wait()
	}
}

func pumpFrames(ctx context.Context, from, to link.FrameTransport) {
	for {
		frame, err := from.Recv(ctx)
		if err != nil {
			return
		}
		if err := to.Send(ctx, frame); err != nil {
			if errors.Is(err, link.ErrTransportClosed) || errors.Is(err, io.EOF) || ctx.Err() != nil {
				return
			}
			return
		}
	}
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
