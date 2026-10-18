package agents

import (
	"context"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

func TestSpawnOwnsPerSessionOptionsWithoutRuntimeWrappers(t *testing.T) {
	adapter := oartest.Runtime(oartest.Options{ID: "fake", Turn: echo})
	start := adapter.Session
	seen := make(chan oar.SessionOptions, 2)
	adapter.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		seen <- options
		return start(ctx, installation, options)
	}
	crew := New(Options{Runtimes: registryOf(t, adapter), Cwd: t.TempDir(), MaxRunning: 2})
	defer crew.Close(context.Background())
	prompt, appendPrompt := "replace", "append"
	_, err := crew.Spawn(testCtx(t), SpawnOptions{Runtime: "fake", Task: "one", Name: "one", SystemPrompt: &prompt, MCPServers: []oar.McpServer{{Name: "farm", Type: "http", URL: "http://farm.test"}}, DisallowedTools: []string{"shell"}})
	if err != nil {
		t.Fatal(err)
	}
	first := <-seen
	_, err = crew.Spawn(testCtx(t), SpawnOptions{Runtime: "fake", Task: "two", Name: "two", AppendSystemPrompt: &appendPrompt})
	if err != nil {
		t.Fatal(err)
	}
	second := <-seen
	if first.SystemPrompt == nil || *first.SystemPrompt != "replace" || len(first.MCPServers) != 1 || len(first.DisallowedTools) != 1 {
		t.Fatalf("first options lost: %+v", first)
	}
	if second.AppendSystemPrompt == nil || *second.AppendSystemPrompt != "append" || second.SystemPrompt != nil || len(second.MCPServers) != 0 || len(second.DisallowedTools) != 0 {
		t.Fatalf("options leaked between sessions: %+v", second)
	}
}

func TestSpawnUsesAcceptedInstallationAndStillChecksRefusals(t *testing.T) {
	adapter := oartest.Runtime(oartest.Options{ID: "fake", Turn: echo})
	probes := 0
	adapter.Installation = func(context.Context, oar.InstallationOptions) (oar.InstallationSnapshot, error) {
		probes++
		return oar.Available(oar.AvailableInstallation{Via: "bundled", Command: "later-command"}), nil
	}
	start := adapter.Session
	command := ""
	adapter.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		command = installation.Command
		return start(ctx, installation, options)
	}
	crew := New(Options{Runtimes: registryOf(t, adapter), Cwd: t.TempDir(), MaxRunning: 2})
	defer crew.Close(context.Background())
	accepted := oar.AvailableInstallation{Via: "bundled", Command: "accepted-command"}
	got, err := crew.Spawn(testCtx(t), SpawnOptions{Runtime: "fake", Task: "one", Name: "one", Installation: &accepted})
	if err != nil || got.Kind != "spawned" || command != "accepted-command" || probes != 0 {
		t.Fatalf("installation changed between acceptance and spawn: %+v %v %s %d", got, err, command, probes)
	}
	adapter.RefusedSessionOptions = oar.RefusedSessionOptions{oar.OptionEnv: "no private env"}
	rejecting := New(Options{Runtimes: registryOf(t, adapter), Cwd: t.TempDir()})
	defer rejecting.Close(context.Background())
	value := "private"
	refused, err := rejecting.Spawn(testCtx(t), SpawnOptions{Runtime: "fake", Task: "two", Name: "two", Installation: &accepted, Env: map[string]*string{"PRIVATE": &value}})
	if err != nil || refused.Kind != "refused" {
		t.Fatalf("accepted installation bypassed option refusal: %+v %v", refused, err)
	}
}
