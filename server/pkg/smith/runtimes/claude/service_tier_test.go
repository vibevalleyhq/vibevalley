//go:build wip_b

package claude

import (
	"regexp"
	"slices"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-service-tier.test.ts.

var tierInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.293"}

// b_tierScripted answers initialize with applied (or the error) and a resume's get_usage with nothing saved.
func b_tierScripted(t *testing.T, applied map[string]any, failure string) (*fakeProcess, *fakeSpawner) {
	fake := newFakeProcess(func(text string, process *fakeProcess) {
		request := b_requestOf(text)
		subtype := jsonx.AsRecord(request["request"])["subtype"]
		if subtype == "get_usage" {
			process.emitJSON(b_controlSuccess(request["request_id"], map[string]any{"session": map[string]any{"model_usage": map[string]any{}}}))
			return
		}
		if subtype != "initialize" {
			return
		}
		if failure == "" {
			process.emitJSON(b_controlSuccess(request["request_id"], applied))
		} else {
			process.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": request["request_id"], "error": failure}})
		}
	})
	return fake, useFakeSpawner(t, fake)
}

func containsInOrder(args []string, pair ...string) bool {
	for index := range args {
		if index+len(pair) <= len(args) && slices.Equal(args[index:index+len(pair)], pair) {
			return true
		}
	}
	return false
}

func TestPerProcessSettingsAndInitializationConfirmFastBeforeOpen(t *testing.T) {
	for _, resume := range []string{"", "old-id"} {
		t.Run("resume="+resume, func(t *testing.T) {
			ctx := testContext(t)
			child, spawner := b_tierScripted(t, map[string]any{"fast_mode_state": "on"}, "")
			session, err := Session(ctx, tierInstallation, oar.SessionOptions{Cwd: "/work", ServiceTier: "fast", Resume: resume})
			if err != nil {
				t.Fatal(err)
			}
			if !containsInOrder(spawner.call(0).args, "--settings", `{"fastMode":true}`) {
				t.Fatalf("args = %v", spawner.call(0).args)
			}
			want := 1
			if resume != "" {
				want = 2
			}
			if len(child.writes()) != want {
				t.Fatalf("writes = %v", child.writes())
			}
			if session.ServiceTier().Value != nil || len(session.Records()) != 0 {
				t.Fatal("the open readback was recorded")
			}
			child.emitJSON(map[string]any{"type": "system", "subtype": "init", "model": "opus", "fast_mode_state": "cooldown"})
			eventually(t, "default tier", func() bool { v := session.ServiceTier().Value; return v != nil && *v == "default" })
			child.emitJSON(map[string]any{"type": "result", "subtype": "success", "fast_mode_state": "on"})
			eventually(t, "fast tier", func() bool { v := session.ServiceTier().Value; return v != nil && *v == "fast" })
			_ = session.Dispose(ctx)
		})
	}
}

func TestExplicitDefaultDisablesFastInsteadOfInheritingUserSettings(t *testing.T) {
	_, spawner := b_tierScripted(t, map[string]any{"fast_mode_state": "off"}, "")
	session, err := Session(testContext(t), tierInstallation, oar.SessionOptions{Cwd: "/work", ServiceTier: "default"})
	if err != nil {
		t.Fatal(err)
	}
	if !containsInOrder(spawner.call(0).args, "--settings", `{"fastMode":false}`) {
		t.Fatalf("args = %v", spawner.call(0).args)
	}
	if session.ServiceTier().Value != nil {
		t.Fatal("tier reported before claude did")
	}
	_ = session.Dispose(testContext(t))
}

func TestConfigurationIntentNeverSubstitutesForActiveFastMode(t *testing.T) {
	for _, applied := range []map[string]any{
		{"fast_mode_state": "off", "fast_mode_disabled_reason": "unsupported_model"},
		{"fast_mode_state": "cooldown"},
		{"effective": map[string]any{"fastMode": true}},
	} {
		child, _ := b_tierScripted(t, applied, "")
		_, err := Session(testContext(t), tierInstallation, oar.SessionOptions{Cwd: "/work", ServiceTier: "fast"})
		if err == nil || !regexp.MustCompile(`although serviceTier fast was requested`).MatchString(err.Error()) {
			t.Fatalf("%v: error = %v", applied, err)
		}
		if !child.killed() {
			t.Fatal("claude was not stopped")
		}
	}
}

func TestNativeControlRejectionNamesTheRequestedTierAndWhy(t *testing.T) {
	child, _ := b_tierScripted(t, map[string]any{}, "initialize rejected")
	_, err := Session(testContext(t), tierInstallation, oar.SessionOptions{Cwd: "/work", ServiceTier: "fast"})
	if err == nil || !regexp.MustCompile(`unreported.*fast.*initialize rejected`).MatchString(err.Error()) {
		t.Fatalf("error = %v", err)
	}
	if !child.killed() {
		t.Fatal("claude was not stopped")
	}
}

func TestUnknownTierFailsBeforeStartingClaude(t *testing.T) {
	spawner := useFakeSpawner(t, newFakeProcess(nil))
	_, err := Session(testContext(t), tierInstallation, oar.SessionOptions{Cwd: "/work", ServiceTier: "priority"})
	if err == nil || !regexp.MustCompile(`cannot apply serviceTier priority`).MatchString(err.Error()) {
		t.Fatalf("error = %v", err)
	}
	if spawner.count() != 0 {
		t.Fatal("claude was started")
	}
}

func TestUnansweredInitializeIsBoundedAndStopsClaude(t *testing.T) {
	b_shorten(t, &claudeEffortReadback, 200*time.Millisecond)
	child := newFakeProcess(nil)
	useFakeSpawner(t, child)
	_, err := Session(testContext(t), tierInstallation, oar.SessionOptions{Cwd: "/work", ServiceTier: "fast"})
	if err == nil || !regexp.MustCompile(`initialize.*serviceTier fast cannot be confirmed`).MatchString(err.Error()) {
		t.Fatalf("error = %v", err)
	}
	if len(child.writes()) != 1 || !child.killed() {
		t.Fatalf("writes %v killed %v", child.writes(), child.killed())
	}
}
