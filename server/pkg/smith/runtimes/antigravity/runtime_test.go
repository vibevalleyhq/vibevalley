package antigravity

// antigravity's cases of the cross-runtime TS tests: tests/install-runtimes.test.ts,
// update-sources.test.ts and inventory.test.ts.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestAntigravityInstallsOnlyFromAnEditorSoItsPlanAndInstallNameTheGUI(t *testing.T) {
	plan, err := InstallPlan(context.Background(), oar.InstallOptions{})
	if err != nil || plan.Kind != "unsupported" || plan.Reason != "requires_gui" {
		t.Fatalf("%+v %v", plan, err)
	}
	t.Setenv("OAR_ANTIGRAVITY_BIN", "/nonexistent/oar-fixture/agy_acp_server.par")
	installed, err := Install(context.Background(), oar.InstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, installed, plan)
}

func TestAntigravityCountsOnlyANewerRegistryVersionAsAnUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/registry.json" {
			writer.WriteHeader(404)
			return
		}
		_, _ = writer.Write([]byte(`{"id":"antigravity-acp","version":"1.2.1"}`))
	}))
	t.Cleanup(server.Close)
	check := UpdateCheck(server.URL + "/registry.json")
	dir := t.TempDir()
	ahead, err := check(context.Background(), oar.AvailableInstallation{Via: "executable", Command: filepath.Join(dir, "agy"), Version: "1.3.0"}, oar.UpdateCheckOptions{})
	if err != nil || ahead.Kind != "ok" || ahead.UpdateAvailable {
		t.Fatalf("%+v %v", ahead, err)
	}
	behind, err := check(context.Background(), oar.AvailableInstallation{Via: "executable", Command: filepath.Join(dir, "agy"), Version: "1.2.0"}, oar.UpdateCheckOptions{})
	if err != nil || behind.Kind != "ok" || !behind.UpdateAvailable {
		t.Fatalf("%+v %v", behind, err)
	}
}

func TestAntigravityHasNoIndependentCommandQueryOnItsSelectedTransport(t *testing.T) {
	commands, err := Runtime().Commands(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/agy"}, oar.InventoryOptions{})
	if err != nil || commands.Kind != "unsupported" || commands.Code != "transport_unavailable" {
		t.Fatalf("%+v %v", commands, err)
	}
}
