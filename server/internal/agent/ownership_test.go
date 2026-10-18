package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/ptr"
)

func TestFailedSaveDoesNotPublishProfiles(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	blocked := t.TempDir()
	s.disk = base.NewFileWriter(blocked, 0600)
	if _, err := s.SaveAgent(protocol.Agent{ID: "not-saved", Runtime: "pi"}); err == nil {
		t.Fatal("expected write failure")
	}
	if s.Agent("not-saved") != nil {
		t.Fatal("failed save changed profiles")
	}
	if _, err := s.SaveSettings("pi", protocol.RuntimeSettings{DefaultModel: "not-saved"}); err == nil {
		t.Fatal("expected write failure")
	}
	if s.Settings("pi").DefaultModel == "not-saved" {
		t.Fatal("failed save changed settings")
	}
}

func TestProfilesAndSettingsOwnTheirSnapshots(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := protocol.Agent{ID: "owned", Runtime: "pi", Skills: []string{"first"}, Env: map[string]string{"key": "original"}, MCPServers: []protocol.MCPServer{{Value: protocol.MCPServerHTTP{Headers: map[string]string{"key": "original"}}}}}
	saved, err := s.SaveAgent(a)
	if err != nil {
		t.Fatal(err)
	}
	a.Env["key"] = "input"
	saved.Skills[0] = "output"
	read := s.Agent(a.ID)
	read.Env["key"] = "read"
	read.Skills[0] = "read"
	read.MCPServers[0].Value.(protocol.MCPServerHTTP).Headers["key"] = "read"
	got := s.Agent(a.ID)
	if got.Env["key"] != "original" || got.Skills[0] != "first" || got.MCPServers[0].Value.(protocol.MCPServerHTTP).Headers["key"] != "original" {
		t.Fatalf("aliased profile: %+v", got)
	}
	settings := protocol.RuntimeSettings{Env: map[string]string{"key": "original"}, DailyBudget: ptr.To(10.0)}
	if _, err := s.SaveSettings("pi", settings); err != nil {
		t.Fatal(err)
	}
	settings.Env["key"] = "input"
	*settings.DailyBudget = 20
	snapshot := s.Settings("pi")
	snapshot.Env["key"] = "read"
	*snapshot.DailyBudget = 30
	gotSettings := s.Settings("pi")
	if gotSettings.Env["key"] != "original" || *gotSettings.DailyBudget != 10 {
		t.Fatalf("aliased settings: %+v", gotSettings)
	}
}

func TestUnreadableProfilesAreNotReplacedWithSeeds(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	original := []byte(`{"agents":[],"skills":[],"settings":{}}`)
	if err := os.WriteFile(path, original, 0000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(path, 0600)
	if _, err := os.ReadFile(path); err == nil {
		t.Skip("process can read mode 0000 files")
	}
	if _, err := New(home); err == nil {
		t.Fatal("started despite read error")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != string(original) {
		t.Fatalf("overwrote unreadable profiles: %s", body)
	}
}

func TestProfileSnapshotCoversEveryMCPMember(t *testing.T) {
	covered := map[reflect.Type]bool{}
	for _, member := range protocol.MCPServerMembers {
		switch member.(type) {
		case protocol.MCPServerStdio:
			original := protocol.MCPServerStdio{Args: []string{"original"}, Env: map[string]string{"key": "original"}}
			copy := cloneAgent(protocol.Agent{MCPServers: []protocol.MCPServer{{Value: original}}}).MCPServers[0].Value.(protocol.MCPServerStdio)
			copy.Args[0] = "changed"
			copy.Env["key"] = "changed"
			if original.Args[0] != "original" || original.Env["key"] != "original" {
				t.Fatal("stdio snapshot aliases state")
			}
		case protocol.MCPServerHTTP:
			original := protocol.MCPServerHTTP{Headers: map[string]string{"key": "original"}}
			copy := cloneAgent(protocol.Agent{MCPServers: []protocol.MCPServer{{Value: original}}}).MCPServers[0].Value.(protocol.MCPServerHTTP)
			copy.Headers["key"] = "changed"
			if original.Headers["key"] != "original" {
				t.Fatal("HTTP snapshot aliases state")
			}
		default:
			t.Fatalf("snapshot copying does not cover %T", member)
		}
		covered[reflect.TypeOf(member)] = true
	}
	if len(covered) != len(protocol.MCPServerMembers) {
		t.Fatal("duplicate MCP members")
	}
}

func TestLoadedProfilesHaveRequiredAppearanceEnums(t *testing.T) {
	home := t.TempDir()
	body, err := json.Marshal(stored{Agents: []protocol.Agent{managerProfile()}, Skills: []protocol.Skill{}, Settings: map[string]protocol.RuntimeSettings{}})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(home, "config.json")
	if err := os.WriteFile(file, body, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := New(home)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range s.All() {
		if !slices.Contains(protocol.BuildValues, a.Look.Build) || !slices.Contains(protocol.HeadValues, a.Look.Head) {
			t.Fatalf("invalid appearance: %+v", a)
		}
	}
	body, err = os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var saved stored
	if err := json.Unmarshal(body, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Agents[0].Look.Build != protocol.BuildBiped || saved.Agents[0].Look.Head != protocol.HeadRounded {
		t.Fatalf("default appearance not persisted: %+v", saved.Agents[0].Look)
	}
}

func TestChangeOwnsNestedRollbackAndPublishedRevision(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := protocol.Agent{ID: "nested", Runtime: "pi", Skills: []string{"first"}, Tags: []string{"tag"}, Env: map[string]string{"key": "old"}, MCPServers: []protocol.MCPServer{{Value: protocol.MCPServerStdio{Args: []string{"arg"}, Env: map[string]string{"key": "old"}}}, {Value: protocol.MCPServerHTTP{Headers: map[string]string{"key": "old"}}}}}
	if _, err := s.SaveAgent(a); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveSettings("pi", protocol.RuntimeSettings{Env: map[string]string{"key": "old"}, DailyBudget: ptr.To(10.0)}); err != nil {
		t.Fatal(err)
	}
	before := cloneStored(s.s)
	disk := s.disk
	s.disk = base.NewFileWriter(t.TempDir(), 0600)
	var held *stored
	mutate := func(work *stored) {
		held = work
		i := slices.IndexFunc(work.Agents, func(a protocol.Agent) bool { return a.ID == "nested" })
		agent := &work.Agents[i]
		agent.Env["key"] = "new"
		agent.Skills[0] = "new"
		agent.Tags[0] = "new"
		*agent.Look.Species = protocol.SpeciesOwl
		agent.MCPServers[0].Value.(protocol.MCPServerStdio).Args[0] = "new"
		agent.MCPServers[0].Value.(protocol.MCPServerStdio).Env["key"] = "new"
		agent.MCPServers[1].Value.(protocol.MCPServerHTTP).Headers["key"] = "new"
		work.Settings["pi"].Env["key"] = "new"
		*work.Settings["pi"].DailyBudget = 20
	}
	if err := s.change(mutate); err == nil {
		t.Fatal("expected disk failure")
	}
	if !reflect.DeepEqual(s.s, before) {
		t.Fatal("nested mutation escaped failed transaction")
	}
	s.disk = disk
	if err := s.change(mutate); err != nil {
		t.Fatal(err)
	}
	committed := cloneStored(s.s)
	held.Settings["pi"].Env["key"] = "retained callback"
	held.Agents[0].Name = "retained callback"
	if !reflect.DeepEqual(s.s, committed) {
		t.Fatal("callback retained ownership of committed revision")
	}
}

func TestCreatedProfileDetachesBothInputAndReturnedDraft(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	draft := protocol.Agent{Name: "created", Runtime: "pi", Env: map[string]string{"key": "original"}, Skills: []string{"skill"}}
	created, err := s.CreateAgent(draft)
	if err != nil {
		t.Fatal(err)
	}
	draft.Env["key"] = "input"
	created.Skills[0] = "output"
	got := s.Agent(created.ID)
	if got.Env["key"] != "original" || got.Skills[0] != "skill" {
		t.Fatalf("created profile aliases caller: %+v", got)
	}
}
