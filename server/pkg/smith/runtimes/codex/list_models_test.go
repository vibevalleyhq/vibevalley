package codex

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/codex/codex-list-models.test.ts, the listing parts of
// codex-service-tier.test.ts and the codex parts of tests/list-models.test.ts.

var listInstallation = oar.AvailableInstallation{Via: "executable", Command: "codex", Version: "0.161.0"}

func TestModelListKeepsNativeIDsAndServiceTiersDropsHiddenEntries(t *testing.T) {
	models := ProjectCodexModels(jsonx.ParseRecord([]byte(`{"data":[
		{"id":"picker-id","model":"gpt-5.5","displayName":" GPT 5.5 ","defaultReasoningEffort":"medium",
		 "supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}],
		 "serviceTiers":[{"id":"priority","name":"Fast"},{"id":"flex"},{}],"defaultServiceTier":"flex","additionalSpeedTiers":["wrong"]},
		{"model":"hidden","hidden":true},{"displayName":"no model"},{"model":"bare","isDefault":true},
		{"model":"standard","serviceTiers":[],"defaultServiceTier":null,"isDefault":false}]}`)))
	sameJSON(t, models[:2], `[
		{"id":"gpt-5.5","displayName":"GPT 5.5","effortLevels":["low","high"],"defaultEffort":"medium","serviceTiers":["priority","flex"],"defaultServiceTier":"flex"},
		{"id":"bare","default":true}]`)
	// TS: {id: "standard", serviceTiers: []}. oar.ModelEntry's JSON drops an
	// empty list (omitempty, smith/GAPS.md); the projection keeps it.
	if len(models) != 3 || models[2].ID != "standard" || models[2].ServiceTiers == nil || len(models[2].ServiceTiers) != 0 || models[2].Default || models[2].DefaultServiceTier != "" {
		t.Fatalf("standard %+v", models[2:])
	}
	if got := ProjectCodexModels(nil); len(got) != 0 {
		t.Fatalf("models %v", got)
	}
}

// #347: a model codex's configuration sets wins over the catalog's isDefault; an unlisted one marks nothing.
func TestDefaultFollowsTheConfiguredModelWhenItIsListed(t *testing.T) {
	models := []oar.ModelEntry{{ID: "gpt-6.1-sol", Default: true}, {ID: "gpt-5.5"}}
	sameJSON(t, codexDefaultModel(models, ""), jsonOf(t, models))
	sameJSON(t, codexDefaultModel(models, "gpt-5.5"), `[{"id":"gpt-6.1-sol"},{"id":"gpt-5.5","default":true}]`)
	sameJSON(t, codexDefaultModel(models, "not-listed"), `[{"id":"gpt-6.1-sol"},{"id":"gpt-5.5"}]`)
}

func TestListerRefusesBundledInstallations(t *testing.T) {
	result, err := ListModels(testContext(t), oar.AvailableInstallation{Via: "bundled", Version: "1"}, oar.ListModelsOptions{})
	if err != nil || result.Kind != "unsupported" {
		t.Fatalf("result %+v %v", result, err)
	}
}

func scriptedExit(t *testing.T, chunks []string, code *int) *fakeProcess {
	fake := newFakeProcess(nil)
	useFakes(t, fake)
	go func() {
		for _, chunk := range chunks {
			fake.emit(chunk)
		}
		fake.end(code, "")
	}()
	return fake
}

func splitReplies(payload jsonx.Record) *fakeProcess {
	return newFakeProcess(func(text string, child *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		id, ok := message["id"].(float64)
		if !ok {
			return
		}
		result := payload
		if message["method"] == "initialize" {
			result = jsonx.Record{}
		}
		reply := jsonText(jsonx.Record{"id": id, "result": result})
		half := len(reply) / 2
		child.emit(reply[:half])
		child.emit(reply[half:] + "\n")
	})
}

func TestListerStreamsMultiChunkRPCRepliesAndProjectsTheModelPicker(t *testing.T) {
	spawner := useFakes(t, splitReplies(jsonx.ParseRecord([]byte(`{"data":[{"model":"gpt-5.5","displayName":"GPT 5.5","supportedReasoningEfforts":[{"reasoningEffort":"low"}]},{"model":"secret","hidden":true}],"nextCursor":null}`))))
	result, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, result, `{"kind":"ok","models":[{"id":"gpt-5.5","displayName":"GPT 5.5","effortLevels":["low"]}]}`)
	call := spawner.call(0)
	if call.command != "codex" || strings.Join(call.args, " ") != "app-server --listen stdio://" {
		t.Fatalf("spawned %s %v", call.command, call.args)
	}
}

func modelServer2(t *testing.T, results map[string]jsonx.Record) (*fakeProcess, *fakeSpawner) {
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		result, ok := results[method]
		if !ok {
			result = jsonx.Record{}
		}
		return jsonx.Record{"result": result}
	})
	return fake, useFakes(t, fake)
}

func configReadParams(fake *fakeProcess) any {
	return requestOf(fake, "config/read")["params"]
}

// #347 (Lookout, codex 0.162.1): a session with no model runs on the configured one, not the catalog's isDefault.
func TestListerMarksTheModelCodexsConfigurationSetsReadForTheHostsCwd(t *testing.T) {
	fake, _ := modelServer2(t, map[string]jsonx.Record{
		"model/list":  jsonx.ParseRecord([]byte(`{"data":[{"model":"gpt-6.1-sol","isDefault":true},{"model":"gpt-5.5"}],"nextCursor":null}`)),
		"config/read": jsonx.ParseRecord([]byte(`{"config":{"model":"gpt-5.5"}}`)),
	})
	result, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, result, `{"kind":"ok","models":[{"id":"gpt-6.1-sol"},{"id":"gpt-5.5","default":true}]}`)
	cwd, _ := os.Getwd()
	sameJSON(t, configReadParams(fake), jsonText(map[string]any{"cwd": cwd, "includeLayers": false}))
}

// rowrow lists per workspace: a project's .codex/config.toml can set another model.
func TestListerReadsTheConfigurationForTheRequestedDirectoryFromAnAppServerStartedLikeASessions(t *testing.T) {
	fake, spawner := modelServer2(t, map[string]jsonx.Record{"model/list": jsonx.ParseRecord([]byte(`{"data":[{"model":"gpt-5.5"}],"nextCursor":null}`))})
	if _, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{Cwd: "workspace"}); err != nil {
		t.Fatal(err)
	}
	workspace, _ := filepath.Abs("workspace")
	sameJSON(t, configReadParams(fake), jsonText(map[string]any{"cwd": workspace, "includeLayers": false}))
	cwd, _ := os.Getwd()
	if dir := spawner.call(0).options.Dir; dir != cwd {
		t.Fatalf("spawned in %s", dir)
	}
}

func TestListerFailsOnANonZeroExitInsteadOfReturningAnEmptyList(t *testing.T) {
	scriptedExit(t, []string{"error: config broken\n"}, intPtr(1))
	_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err == nil || !strings.Contains(err.Error(), "Failed to list Codex models") {
		t.Fatalf("err %v", err)
	}
}

func TestListerRequiresAValidRPCReplyEvenWhenTheProcessExitsCleanly(t *testing.T) {
	scriptedExit(t, []string{"not json\n"}, intPtr(0))
	_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err == nil || err.Error() != "Failed to list Codex models" || errors.Unwrap(err) == nil || errors.Unwrap(err).Error() != "app-server exited: exit code 0; signal none" {
		t.Fatalf("err %v (cause %v)", err, errors.Unwrap(err))
	}
}

func TestListerKillsTheProcessOnTimeout(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakes(t, fake)
	_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{Timeout: 20 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "Failed to list Codex models") {
		t.Fatalf("err %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func pagedServer(t *testing.T, pages []string) *fakeProcess {
	page := 0
	fake := rpcServer(func(method string, _ jsonx.Record, _ *fakeProcess) jsonx.Record {
		if method == "model/list" {
			result := jsonx.ParseRecord([]byte(pages[page]))
			page++
			return jsonx.Record{"result": result}
		}
		return jsonx.Record{"result": jsonx.Record{}}
	})
	useFakes(t, fake)
	return fake
}

func TestModelListingUsesAppServerPaginationAndStopsItsProcess(t *testing.T) {
	fake := pagedServer(t, []string{
		`{"data":[{"model":"a","serviceTiers":[{"id":"priority"}]}],"nextCursor":"next"}`,
		`{"data":[{"model":"b","serviceTiers":[{"id":"flex"}],"defaultServiceTier":"flex"}],"nextCursor":null}`,
	})
	result, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	sameJSON(t, result, `{"kind":"ok","models":[{"id":"a","serviceTiers":["priority"]},{"id":"b","serviceTiers":["flex"],"defaultServiceTier":"flex"}]}`)
	params := []any{}
	for _, request := range fake.requests() {
		if request["method"] == "model/list" {
			params = append(params, request["params"])
		}
	}
	sameJSON(t, params, `[{},{"cursor":"next"}]`)
	if !fake.killed() {
		t.Fatal("not killed")
	}
}

func TestModelListingRejectsMalformedOrLoopingPaginationAndReclaimsTheProcess(t *testing.T) {
	for _, pages := range [][]string{{`{}`}, {`{"data":[],"nextCursor":"same"}`, `{"data":[],"nextCursor":"same"}`}} {
		fake := pagedServer(t, pages)
		_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{})
		if err == nil || !strings.Contains(err.Error(), "Failed to list Codex models") {
			t.Fatalf("err %v", err)
		}
		if !fake.killed() {
			t.Fatal("not killed")
		}
	}
}

func TestModelListingHasOneDeadlineIncludingInitialization(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakes(t, fake)
	_, err := ListModels(testContext(t), listInstallation, oar.ListModelsOptions{Timeout: 10 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "timed out after 10 ms") {
		t.Fatalf("err %v", err)
	}
	if !fake.killed() {
		t.Fatal("not killed")
	}
}
