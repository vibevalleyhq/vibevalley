package dsh

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// The test binary stands in for `dsh --profile acp` when DSH_FAKE names the file it logs to: it answers with what
// dsh 0.2.1-rc.2 answered (testdata), and logs every request.
func TestMain(m *testing.M) {
	if log := os.Getenv("DSH_FAKE"); log != "" {
		fake(log)
		return
	}
	os.Exit(m.Run())
}

// The fake runs in the session's directory: the test hands it the absolute path.
func answersFile() string {
	if file := os.Getenv("DSH_FAKE_ANSWERS"); file != "" {
		return file
	}
	file, _ := filepath.Abs(filepath.Join("testdata", "acp-0.2.1-rc.2.json"))
	return file
}

// t is nil in the fake.
func probed(t testing.TB) map[string]json.RawMessage {
	body, err := os.ReadFile(answersFile())
	if err != nil && t != nil {
		t.Fatal(err)
	}
	var answers map[string]json.RawMessage
	if err := json.Unmarshal(body, &answers); err != nil && t != nil {
		t.Fatal(err)
	}
	return answers
}

func fake(log string) {
	answers := probed(nil)
	out, _ := os.Create(log)
	defer out.Close()
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(nil, 1<<20)
	for in.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(in.Bytes(), &message) != nil || message.ID == nil || message.Method == "" {
			continue
		}
		line, _ := json.Marshal(map[string]any{"method": message.Method, "params": message.Params})
		out.Write(append(line, '\n'))
		answer, ok := answers[message.Method]
		switch message.Method {
		case "session/set_config_option":
			answers["session/new"] = applied(answers["session/new"], message.Params)
			answer, ok = answers["session/new"], true
		case "session/prompt":
			answer, ok = json.RawMessage(`{"stopReason":"end_turn"}`), true
		}
		if !ok {
			answer = json.RawMessage(`{}`)
		}
		reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": answer})
		os.Stdout.Write(append(reply, '\n'))
	}
}

// applied is the session's options with the one set: dsh answers set_config_option with every option.
func applied(opened, params json.RawMessage) json.RawMessage {
	var set struct{ ConfigID, Value string }
	var response struct{ ConfigOptions []map[string]any }
	_ = json.Unmarshal(params, &set)
	_ = json.Unmarshal(opened, &response)
	for _, option := range response.ConfigOptions {
		if option["id"] == set.ConfigID {
			option["currentValue"] = set.Value
		}
	}
	answer, _ := json.Marshal(map[string]any{"sessionId": "dsh-session", "configOptions": response.ConfigOptions})
	return answer
}

func TestOptionValue(t *testing.T) {
	for model, want := range map[string]string{
		"deepseek-flash":                   `["deepseek-official","deepseek-flash"]`,
		"deepseek-official/deepseek-flash": `["deepseek-official","deepseek-flash"]`,
		`["openrouter","x"]`:               `["openrouter","x"]`,
		"":                                 "",
	} {
		if got := OptionValue(model); got != want {
			t.Errorf("OptionValue(%q) = %q, want %q", model, got, want)
		}
	}
	if got := ModelID(`["deepseek-official","deepseek-flash"]`); got != "deepseek-official/deepseek-flash" {
		t.Errorf("ModelID = %q", got)
	}
}

func TestProjectModelsReadsGroups(t *testing.T) {
	var response map[string]any
	if err := json.Unmarshal(probed(t)["session/new"], &response); err != nil {
		t.Fatal(err)
	}
	models := ProjectModels(response)
	var ids []string
	for _, m := range models {
		ids = append(ids, m.ID)
		if !slices.Equal(m.EffortLevels, []string{"low", "high", "max"}) || m.DefaultEffort != "high" {
			t.Errorf("%s: efforts %v default %q", m.ID, m.EffortLevels, m.DefaultEffort)
		}
	}
	if want := []string{"deepseek-official/deepseek-v4-flash", "deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"}; !slices.Equal(ids, want) {
		t.Fatalf("ids %v, want %v", ids, want)
	}
	if !models[0].Default || models[1].Default || models[1].DisplayName != "DeepSeek-V4.1-Flash-1017" || models[2].DisplayName != "DeepSeek-V4-Pro" {
		t.Fatalf("models %+v", models)
	}
}

func TestSessionSetsTheModelByItsPair(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "log.jsonl")
	t.Setenv("DSH_FAKE", log)
	t.Setenv("DSH_FAKE_ANSWERS", answersFile())
	session, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: self},
		oar.SessionOptions{Cwd: t.TempDir(), Model: "deepseek-flash", Effort: "low"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Prompt(context.Background(), "hi", oar.InputOptions{}); err != nil {
		t.Fatal(err)
	}
	if model := session.Model().Value; model == nil || *model != "deepseek-official/deepseek-flash" {
		t.Errorf("session model %q", *model)
	}
	_ = session.Dispose(context.Background())
	body, _ := os.ReadFile(log)
	var values []string
	for _, line := range bytes.Split(body, []byte("\n")) {
		var entry struct {
			Method string
			Params struct{ ConfigID, Value string }
		}
		if json.Unmarshal(line, &entry) == nil && entry.Method == "session/set_config_option" {
			values = append(values, entry.Params.ConfigID+"="+entry.Params.Value)
		}
	}
	if !slices.Contains(values, `model=["deepseek-official","deepseek-flash"]`) || !slices.Contains(values, "reasoning_effort=low") {
		t.Fatalf("set_config_option calls %v", values)
	}
}

func TestRefusesASystemPrompt(t *testing.T) {
	prompt := "x"
	_, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "/nonexistent"},
		oar.SessionOptions{Cwd: t.TempDir(), SystemPrompt: &prompt})
	if err == nil {
		t.Fatal("a system prompt was accepted")
	}
}
