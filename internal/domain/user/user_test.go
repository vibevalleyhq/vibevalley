package user

import (
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

func TestUserAuthLockoutAndPersistence(t *testing.T) {
	t.Parallel()

	home := t.TempDir()
	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	svc, err := NewService(Options{HomeDir: home, Clock: clk, PBKDF2Iterations: 2000})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	// Remote caller cannot setup or change password.
	if _, err := svc.Setup(Caller{Here: false}, "Alice", "correct horse"); !errors.Is(err, ErrAuthRefused) {
		t.Fatalf("expected ErrAuthRefused for remote Setup, got %v", err)
	}
	if _, err := svc.SetPassword(Caller{Here: false}, "correct horse"); !errors.Is(err, ErrAuthRefused) {
		t.Fatalf("expected ErrAuthRefused for remote SetPassword, got %v", err)
	}
	if _, err := svc.SetPassword(Caller{Here: true}, "short"); !errors.Is(err, ErrAuthRefused) {
		t.Fatalf("expected ErrAuthRefused for short password, got %v", err)
	}

	st, err := svc.Setup(Caller{Here: true}, "  Alice \n Smith ", "correct horse")
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if st.Name != "Alice Smith" || !st.Password || !st.Here {
		t.Fatalf("unexpected status after Setup: %+v", st)
	}

	// Unauthenticated LAN caller never sees owner name.
	if remote := svc.Status(Caller{Here: false}); remote.Name != "" || !remote.Password {
		t.Fatalf("unauthenticated LAN caller leaked name or missed password flag: %+v", remote)
	}

	// Change password enforces current password check.
	if _, err := svc.ChangePassword(Caller{Here: true}, "wrong-old", "new password 123"); !errors.Is(err, ErrAuthRefused) {
		t.Fatalf("expected wrong old password error, got %v", err)
	}
	if _, err := svc.ChangePassword(Caller{Here: true}, "correct horse", "new password 123"); err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}

	// 5 wrong logins trigger 60s lockout.
	for i := range 5 {
		if _, err := svc.Login("guess", "Laptop"); !errors.Is(err, ErrAuthRefused) {
			t.Fatalf("attempt %d: expected ErrAuthRefused, got %v", i, err)
		}
	}
	if _, err := svc.Login("new password 123", "Laptop"); !errors.Is(err, ErrAuthRefused) || !strings.Contains(err.Error(), "retry in") {
		t.Fatalf("expected lockout error even with right password, got %v", err)
	}

	clk.Advance(61 * time.Second)
	login, err := svc.Login("new password 123", "  Work\nLaptop ")
	if err != nil {
		t.Fatalf("Login after lockout expiry: %v", err)
	}
	if !strings.HasPrefix(login.Key, "vvk_") || login.Device == "" {
		t.Fatalf("unexpected login result: %+v", login)
	}

	// auth-state.json is 0600 and never stores raw keys or raw passwords.
	authPath := filepath.Join(home, authStateFileName)
	info, err := os.Stat(authPath)
	if err != nil {
		t.Fatalf("stat auth-state.json: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 permissions, got %o", info.Mode().Perm())
	}
	rawDisk, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"new password 123", "correct horse", login.Key} {
		if strings.Contains(string(rawDisk), secret) {
			t.Fatalf("auth-state.json exposed secret %q", secret)
		}
	}

	// Reload from disk verifies token and password still verify cleanly.
	reloaded, err := NewService(Options{HomeDir: home, Clock: clk, PBKDF2Iterations: 2000})
	if err != nil {
		t.Fatalf("reload NewService: %v", err)
	}
	dev, ok := reloaded.VerifyToken(login.Key)
	if !ok || dev.ID != login.Device || dev.Name != "Work Laptop" || dev.Came != DeviceCameLogin {
		t.Fatalf("VerifyToken after reload failed: ok=%v dev=%+v", ok, dev)
	}
	if authedStatus := reloaded.Status(Caller{Here: false, DeviceID: dev.ID}); authedStatus.Name != "Alice Smith" {
		t.Fatalf("expected authenticated LAN caller to see profile name, got %+v", authedStatus)
	}

	if err := reloaded.Logout(Caller{Here: false, DeviceID: dev.ID}); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if _, ok := reloaded.VerifyToken(login.Key); ok {
		t.Fatalf("token should fail after Logout")
	}
}

func TestDeviceIdleExpiryRevocationAndRequestExtraction(t *testing.T) {
	t.Parallel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	svc, err := NewService(Options{Clock: clk})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	revCh, unsub := svc.SubscribeRevoked()
	defer unsub()

	kept, err := svc.MintDevice("Phone", DeviceCamePaired)
	if err != nil {
		t.Fatalf("MintDevice kept: %v", err)
	}
	stale, err := svc.MintDevice("Old Tablet", DeviceCamePaired)
	if err != nil {
		t.Fatalf("MintDevice stale: %v", err)
	}

	// ExtractTokenFromRequest supports Bearer header and cookie.
	reqBearer := httptest.NewRequest("GET", "/", nil)
	reqBearer.Header.Set("Authorization", "Bearer "+kept.Key)
	if got := ExtractTokenFromRequest(reqBearer); got != kept.Key {
		t.Fatalf("bearer extraction mismatch: %q", got)
	}
	reqCookie := httptest.NewRequest("GET", "/", nil)
	reqCookie.Header.Set("Cookie", DeviceKeyCookie+"="+kept.Key)
	if got := ExtractTokenFromRequest(reqCookie); got != kept.Key {
		t.Fatalf("cookie extraction mismatch: %q", got)
	}

	prev, err := svc.PreviewRevokeDevice(stale.Device)
	if err != nil || len(prev.Does) == 0 {
		t.Fatalf("PreviewRevokeDevice failed: %v %+v", err, prev)
	}

	// Advance 89 days: touch kept, leave stale untouched.
	clk.Advance(89 * 24 * time.Hour)
	if _, ok := svc.VerifyToken(kept.Key); !ok {
		t.Fatalf("kept device should still be valid at 89 days")
	}

	// Advance 2 more days (total 91 days for stale, 2 days since kept last seen).
	clk.Advance(2 * 24 * time.Hour)
	if _, ok := svc.VerifyToken(stale.Key); ok {
		t.Fatalf("stale device should expire past 90 days idle")
	}
	select {
	case revID := <-revCh:
		if revID != stale.Device {
			t.Fatalf("expected revoked ID %q, got %q", stale.Device, revID)
		}
	default:
		t.Fatalf("expected revocation event for idle device")
	}
	if devs := svc.ListDevices(); len(devs) != 1 || devs[0].ID != kept.Device {
		t.Fatalf("expected only kept device remaining, got %+v", devs)
	}
}

func TestCLIApprovalQueueAndSlowDown(t *testing.T) {
	t.Parallel()

	clk := store.NewFakeClock(time.Unix(1_700_000_000, 0))
	svc, err := NewService(Options{Clock: clk})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	created, err := svc.CreateApproval(Caller{Here: false, From: "192.168.1.50"}, "  CLI\nBox ")
	if err != nil {
		t.Fatalf("CreateApproval: %v", err)
	}
	if !regexp.MustCompile(`^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`).MatchString(created.Code) {
		t.Fatalf("unexpected approval code %q", created.Code)
	}

	// First poll returns empty pending state; immediate second poll triggers RFC 8628 slow_down (+5s).
	first, err := svc.PollApproval(created.Claim)
	if err != nil || first.Login != nil || first.Every != nil {
		t.Fatalf("unexpected first poll: err=%v res=%+v", err, first)
	}
	tooSoon, err := svc.PollApproval(created.Claim)
	if err != nil || tooSoon.Every == nil || *tooSoon.Every != 7 {
		t.Fatalf("expected slow_down every=7, got err=%v res=%+v", err, tooSoon)
	}

	clk.Advance(7 * time.Second)
	waited, err := svc.PollApproval(created.Claim)
	if err != nil || waited.Every != nil || waited.Login != nil {
		t.Fatalf("expected clean pending poll after interval, got err=%v res=%+v", err, waited)
	}

	pending := svc.ListApprovals()
	if len(pending) != 1 || pending[0].From != "192.168.1.50" || pending[0].Name != "CLI Box" {
		t.Fatalf("unexpected pending approvals: %+v", pending)
	}

	// Approving does not mint the device until collected; collection is single-use.
	remaining, err := svc.AnswerApproval(pending[0].ID, true)
	if err != nil || len(remaining) != 1 {
		t.Fatalf("AnswerApproval: err=%v remaining=%+v", err, remaining)
	}
	if len(svc.ListDevices()) != 0 {
		t.Fatalf("device should not be minted before PollApproval collection")
	}

	collected, err := svc.PollApproval(created.Claim)
	if err != nil || collected.Login == nil || !strings.HasPrefix(collected.Login.Key, "vvk_") {
		t.Fatalf("expected minted login on collect, got err=%v res=%+v", err, collected)
	}
	if _, err := svc.PollApproval(created.Claim); !errors.Is(err, ErrApprovalGone) {
		t.Fatalf("expected ErrApprovalGone on second collect, got %v", err)
	}

	// Enforces max 5 concurrent pending approvals.
	for range 5 {
		if _, err := svc.CreateApproval(Caller{Here: true}, "node"); err != nil {
			t.Fatalf("CreateApproval within limit failed: %v", err)
		}
	}
	if _, err := svc.CreateApproval(Caller{Here: true}, "sixth"); !errors.Is(err, ErrAuthRefused) {
		t.Fatalf("expected ErrAuthRefused when exceeding max 5 pending approvals, got %v", err)
	}
}
