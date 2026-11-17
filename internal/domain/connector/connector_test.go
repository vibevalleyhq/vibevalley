package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

func TestConnectorLifecyclePersistenceAndChannelBinding(t *testing.T) {
	t.Parallel()

	home := t.TempDir()
	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	var events []ConnectorStatus

	svc, err := NewService(Options{
		HomeDir: home,
		Clock:   clk,
		ChannelValidator: func(_ context.Context, name string) (string, bool, error) {
			switch name {
			case "":
				return "", true, nil
			case "ops":
				return "chan-ops", false, nil
			default:
				return "", false, errors.New("unknown channel")
			}
		},
		OnChange: func(st ConnectorStatus) {
			events = append(events, st)
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Default list contains built-in connectors all initially off.
	list := svc.List()
	if len(list) != len(DefaultConnectors) {
		t.Fatalf("expected %d default connectors, got %d", len(DefaultConnectors), len(list))
	}
	for _, st := range list {
		if st.State != StateOff {
			t.Fatalf("expected initial state off for %s, got %s", st.ID, st.State)
		}
	}

	// Telegram direct bot token login connects immediately and redacts secret from status.
	tgStatus, err := svc.Login(context.Background(), ConnectorTelegram, ConnectorLogin{BotToken: "12345:tg-secret-token"})
	if err != nil {
		t.Fatalf("telegram Login: %v", err)
	}
	if tgStatus.State != StateConnected || tgStatus.Since == nil {
		t.Fatalf("unexpected telegram status: %+v", tgStatus)
	}
	if raw, _ := json.Marshal(tgStatus); strings.Contains(string(raw), "tg-secret-token") {
		t.Fatalf("ConnectorStatus leaked bot token: %s", string(raw))
	}

	// Feishu AppID/Secret enters pairing with a 6-digit pairCode; Verify completes pairing.
	fsStatus, err := svc.Login(context.Background(), ConnectorFeishu, ConnectorLogin{AppID: "cli_123", Secret: "feishu-sec"})
	if err != nil {
		t.Fatalf("feishu Login: %v", err)
	}
	if fsStatus.State != StatePairing || len(fsStatus.PairCode) != 6 {
		t.Fatalf("expected pairing state with 6-digit pairCode, got %+v", fsStatus)
	}
	if _, err := svc.Verify(context.Background(), ConnectorFeishu, "000000"); !errors.Is(err, ErrConnectorRefused) && fsStatus.PairCode != "000000" {
		t.Fatalf("expected pairing code rejection, got err=%v", err)
	}
	verified, err := svc.Verify(context.Background(), ConnectorFeishu, fsStatus.PairCode)
	if err != nil || verified.State != StateConnected || verified.PairCode != "" {
		t.Fatalf("Verify pairing failed: err=%v st=%+v", err, verified)
	}

	// SetChannel validates and binds channel.
	if _, err := svc.SetChannel(context.Background(), ConnectorFeishu, "nonexistent"); !errors.Is(err, ErrConnectorRefused) {
		t.Fatalf("expected unknown channel error, got %v", err)
	}
	bound, err := svc.SetChannel(context.Background(), ConnectorFeishu, "ops")
	if err != nil || bound.Channel != "chan-ops" {
		t.Fatalf("SetChannel ops failed: err=%v st=%+v", err, bound)
	}

	// Persisted file uses 0600 permissions and survives reload.
	diskPath := filepath.Join(home, connectorsFileName)
	info, err := os.Stat(diskPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 file %s: err=%v info=%v", diskPath, err, info)
	}
	reloaded, err := NewService(Options{HomeDir: home, Clock: clk})
	if err != nil {
		t.Fatalf("reload NewService: %v", err)
	}
	gotFeishu, err := reloaded.Get(ConnectorFeishu)
	if err != nil || gotFeishu.State != StateConnected || gotFeishu.Channel != "chan-ops" {
		t.Fatalf("reloaded feishu mismatch: err=%v st=%+v", err, gotFeishu)
	}

	// Logout clears account state and persists.
	loggedOut, err := reloaded.Logout(context.Background(), ConnectorFeishu)
	if err != nil || loggedOut.State != StateOff || loggedOut.Channel != "" {
		t.Fatalf("Logout failed: err=%v st=%+v", err, loggedOut)
	}
	if len(events) < 4 {
		t.Fatalf("expected OnChange callbacks to fire, got %d", len(events))
	}
}

func TestConnectorWeixinQRAndVerificationFlow(t *testing.T) {
	t.Parallel()

	svc, err := NewService(Options{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	st, err := svc.Login(context.Background(), ConnectorWeixin, ConnectorLogin{})
	if err != nil {
		t.Fatalf("Weixin QR Login: %v", err)
	}
	if st.State != StateWaiting || st.QR == "" {
		t.Fatalf("expected waiting state with QR URI, got %+v", st)
	}

	verified, err := svc.Verify(context.Background(), ConnectorWeixin, "123456")
	if err != nil || verified.State != StateConnected {
		t.Fatalf("Weixin Verify failed: err=%v st=%+v", err, verified)
	}
}
