package codex

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Ports the codex parts of tests/install-runtimes.test.ts,
// installation.test.ts, update-projections.test.ts, update.test.ts and
// inventory.test.ts.

func TestTheScriptedInstallerIsOpenAIsDocumentedLine(t *testing.T) {
	linux := shared.InstallHost{Platform: "linux", Arch: "arm64", Locate: func(tool string) string { return "/usr/bin/" + tool }, Unwritable: func(string) string { return "" }}
	plan := shared.ScriptInstallPlanOn(codexInstallMethod, linux)
	if plan.Kind != "plan" || len(plan.Steps) != 1 || plan.Steps[0].Display != "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh" || plan.Source != "https://github.com/openai/codex#installing-and-running-codex-cli" {
		t.Fatalf("plan %+v", plan)
	}
}

func TestCandidatesAreTheDesktopAppBundlesThenTheStandaloneInstallersLauncher(t *testing.T) {
	sameJSON(t, codexInstalledExecutableCandidates("linux", "/home/oar", "/opt/codex/bin"), `["/opt/codex/bin/codex","/home/oar/.local/bin/codex"]`)
	sameJSON(t, codexInstalledExecutableCandidates("darwin", "/Users/oar", ""), `[
		"/Applications/ChatGPT.app/Contents/Resources/codex","/Applications/Codex.app/Contents/Resources/codex",
		"/Users/oar/Applications/ChatGPT.app/Contents/Resources/codex","/Users/oar/Applications/Codex.app/Contents/Resources/codex",
		"/Users/oar/.local/bin/codex"]`)
	sameJSON(t, codexInstalledExecutableCandidates("win32", `C:\Users\oar`, ""), `[]`)
}

func TestCodexProbesThroughItsPinEnvVar(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	t.Setenv("OAR_CODEX_BIN", node)
	snapshot, err := Installation(testContext(t), oar.InstallationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, snapshot, `{"kind":"unsupported","reason":"app-server --help failed"}`)
}

func doctor(status, latest string) any {
	details := jsonx.Record{"latest version status": status}
	if latest != "" {
		details["latest version"] = latest
	}
	return jsonx.Record{"checks": jsonx.Record{"updates.status": jsonx.Record{"details": details}}}
}

func TestReadsTheUpdatesStatusRowOfDoctorJSON(t *testing.T) {
	sameJSON(t, projectCodexUpdateStatus("0.158.0", doctor("newer version is available", "0.159.3")), `{"kind":"ok","installed":"0.158.0","latest":"0.159.3","updateAvailable":true,"source":"codex doctor --json"}`)
	if current := projectCodexUpdateStatus("0.159.3", doctor("current version is not older", "0.159.3")); current.Kind != "ok" || current.UpdateAvailable {
		t.Fatalf("current %+v", current)
	}
	if unknown := projectCodexUpdateStatus("0.158.0", doctor("unknown", "")); unknown.Kind != "unavailable" {
		t.Fatalf("unknown %+v", unknown)
	}
	copied := jsonx.ParseRecord([]byte(`{"checks":{"updates.status":{"details":{"latest version":"0.159.3","update action":"manual or unknown"}}}}`))
	if unmanaged := projectCodexUpdateStatus("0.158.0", copied); unmanaged.Kind != "unavailable" || unmanaged.Reason != "unmanaged_installation" {
		t.Fatalf("unmanaged %+v", unmanaged)
	}
}

func TestTheCheckReadsDoctorsJSONEvenWhenDoctorExits1(t *testing.T) {
	doctorJSON := `{"overallStatus":"fail","checks":{"updates.status":{"details":{"latest version":"0.159.3","latest version status":"newer version is available","update action":"standalone installer"}}}}`
	command := filepath.Join(t.TempDir(), "codex-doctor")
	if err := os.WriteFile(command, []byte("#!/bin/sh\necho '"+doctorJSON+"'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	check, err := CheckUpdate(testContext(t), oar.AvailableInstallation{Via: "executable", Command: command, Version: "codex-cli 0.158.0"}, oar.UpdateCheckOptions{})
	if err != nil || check.Kind != "ok" || !check.UpdateAvailable {
		t.Fatalf("check %+v %v", check, err)
	}
}

// ─── inventory.test.ts ──────────────────────────────────────────────────────

var inventoryInstallation = oar.AvailableInstallation{Via: "executable", Command: "fake"}

func TestForwardsResolvedCwdAndPreservesDisabledSkillsWithoutCreatingAThread(t *testing.T) {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.ParseRecord([]byte(`{"data":[{"skills":[{"name":"review","enabled":false,"path":"/skills/review","scope":"user","description":"Review"}],"errors":[{"message":"private error text"}]}]}`))}
	})
	spawner := useFakes(t, fake)
	result, err := Skills(testContext(t), inventoryInstallation, oar.InventoryOptions{Cwd: "./project-b"})
	if err != nil {
		t.Fatal(err)
	}
	projectB, _ := filepath.Abs("./project-b")
	result.ObservedAt = "2026-09-16T00:00:00.000Z"
	sameJSON(t, result, `{"kind":"ok","scope":{"kind":"workspace","cwd":`+jsonText(projectB)+`},"observedAt":"2026-09-16T00:00:00.000Z","view":"discovered","partial":true,
		"items":[{"name":"review","enabled":false,"path":"/skills/review","source":"user","description":"Review"}]}`)
	calls := []any{}
	for _, request := range fake.requests() {
		calls = append(calls, []any{request["method"], request["params"]})
	}
	sameJSON(t, calls, `[["initialize",{"clientInfo":{"name":"oar-inventory","version":"0.0.0"},"capabilities":{"experimentalApi":true}}],["skills/list",{"cwds":[`+jsonText(projectB)+`]}]]`)
	if dir := spawner.call(0).options.Dir; dir != projectB {
		t.Fatalf("spawned in %s", dir)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestExhaustsMcpPagesAndLabelsToolsAsMcpOnlyWithoutExposingConfig(t *testing.T) {
	cursors := []any{}
	fake := rpcServer(func(method string, params jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		cursors = append(cursors, params["cursor"])
		if params["cursor"] == nil {
			return jsonx.Record{"result": jsonx.ParseRecord([]byte(`{"data":[{"name":"one","tools":{"read":{"name":"read","description":"Read","inputSchema":{"type":"object"}}},"config":{"token":"secret"}}],"nextCursor":"next"}`))}
		}
		return jsonx.Record{"result": jsonx.ParseRecord([]byte(`{"data":[{"name":"two","tools":{},"toolsError":"Authorization: secret"}],"nextCursor":null}`))}
	})
	useFakes(t, fake)
	result, err := Tools(testContext(t), inventoryInstallation, oar.InventoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cwd, _ := os.Getwd()
	result.ObservedAt = "2026-09-16T00:00:00.000Z"
	sameJSON(t, result, `{"kind":"ok","scope":{"kind":"workspace","cwd":`+jsonText(cwd)+`},"observedAt":"2026-09-16T00:00:00.000Z","view":"mcp-only","partial":true,
		"items":[{"name":"read","description":"Read","mcpServerId":"one","source":"mcp","inputSchema":{"type":"object"}}]}`)
	sameJSON(t, cursors, `[null,"next"]`)
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestToolsKeepTheirWireOrder(t *testing.T) {
	useFakes(t, rpcServer(func(method string, _ jsonx.Record, fake *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		fake.emit(`{"id":2,"result":{"data":[{"name":"one","tools":{"zeta":{"name":"zeta"},"alpha":{"name":"alpha"}}}],"nextCursor":null}}` + "\n")
		return nil
	}))
	result, err := Tools(testContext(t), inventoryInstallation, oar.InventoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 2 || result.Items[0].Name != "zeta" || result.Items[1].Name != "alpha" {
		t.Fatalf("items %+v", result.Items)
	}
}

func TestRepeatOrMalformedPaginationIsFailureNotEmptySuccess(t *testing.T) {
	for _, mode := range []string{"repeat", "malformed"} {
		fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
			if method == "initialize" {
				return jsonx.Record{"result": jsonx.Record{}}
			}
			if mode == "repeat" {
				return jsonx.Record{"result": jsonx.Record{"data": []any{}, "nextCursor": "same"}}
			}
			return jsonx.Record{"result": jsonx.Record{"data": "invalid", "nextCursor": nil}}
		})
		useFakes(t, fake)
		result, err := MCPServers(testContext(t), inventoryInstallation, oar.InventoryOptions{})
		if err != nil || result.Kind != "unavailable" || result.Code != "query_failed" {
			t.Fatalf("%s: %+v %v", mode, result, err)
		}
		if !fake.killed() {
			t.Fatal("not killed")
		}
	}
}

func TestUnknownMcpStatusRemainsAbsentNotConnected(t *testing.T) {
	useFakes(t, rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "initialize" {
			return jsonx.Record{"result": jsonx.Record{}}
		}
		return jsonx.Record{"result": jsonx.ParseRecord([]byte(`{"data":[{"name":"a","runtimeStatus":null,"authStatus":"unsupported","tools":{}}],"nextCursor":null}`))}
	}))
	result, err := MCPServers(testContext(t), inventoryInstallation, oar.InventoryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	matchJSON(t, result, `{"kind":"ok","items":[{"id":"a","name":"a","authStatus":"unsupported","toolCount":0}]}`)
	if strings.Contains(jsonText(result.Items[0]), `"status"`) {
		t.Fatalf("item %s", jsonText(result.Items[0]))
	}
}

func TestTimeoutReleasesOwnedDiscoveryProcess(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakes(t, fake)
	result, err := Skills(testContext(t), inventoryInstallation, oar.InventoryOptions{Timeout: 30 * time.Millisecond})
	if err != nil || result.Kind != "unavailable" || result.Code != "timeout" {
		t.Fatalf("result %+v %v", result, err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}
