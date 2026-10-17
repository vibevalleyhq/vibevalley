package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestAnUnreadableConfigIsKeptAside(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "config.json")
	if err := os.WriteFile(file, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Agents()) == 0 {
		t.Fatal("the seeds are not there")
	}
	kept, _ := filepath.Glob(file + ".unreadable-*")
	if len(kept) != 1 {
		t.Fatalf("kept aside: %v", kept)
	}
	if body, _ := os.ReadFile(kept[0]); string(body) != "{not json" {
		t.Fatalf("what was kept: %q", body)
	}
}

// Rather no start than the seeds written over the owner's profiles.
func TestAConfigThatCannotBeKeptAsideStopsTheStart(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "config.json")
	if err := os.WriteFile(file, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(home, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(home, 0o755) })
	if _, err := New(home); err == nil || !strings.Contains(err.Error(), "kept aside") {
		t.Fatalf("started anyway: %v", err)
	}
	if body, _ := os.ReadFile(file); string(body) != "{not json" {
		t.Fatalf("the file was touched: %q", body)
	}
}

// The same animals the client's castOf picks (app/test/desk_rules_test.dart), so filling one in changes nothing on screen.
func TestAProfileWithoutAnAnimalGetsTheOneItShowed(t *testing.T) {
	for id, want := range map[string]protocol.Species{"backend": protocol.SpeciesCat, "agent-7": protocol.SpeciesFox, "老周": protocol.SpeciesHedgehog} {
		got := withCast(protocol.Agent{ID: id})
		testkit.Eq(t, [2]any{*got.Look.Species, *got.Look.Outfit}, [2]any{want, protocol.OutfitFarmer}, id)
	}
	owl, rain := protocol.SpeciesOwl, protocol.OutfitRain
	kept := withCast(protocol.Agent{ID: "backend", Look: protocol.Look{Species: &owl, Outfit: &rain}})
	testkit.Eq(t, [2]any{*kept.Look.Species, *kept.Look.Outfit}, [2]any{owl, rain}, "its own are kept")
}

func TestOldProfilesAreFilledInOnceOnLoad(t *testing.T) {
	home := t.TempDir()
	file := filepath.Join(home, "config.json")
	old := `{"agents":[{"id":"backend","name":"后端","runtime":"pi","look":{"build":"biped","head":"rounded","body":"#fff","trim":"#000","hat":"#f00","eye":"#0ff"}}],"skills":[],"settings":{}}`
	if err := os.WriteFile(file, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(home)
	if err != nil {
		t.Fatal(err)
	}
	a := s.Agent("backend")
	testkit.Eq(t, [2]any{*a.Look.Species, *a.Look.Outfit}, [2]any{protocol.SpeciesCat, protocol.OutfitFarmer}, "filled in")
	body, _ := os.ReadFile(file)
	testkit.Match(t, string(body), `"species":"cat","outfit":"farmer"`, "and written back")
	saved, _ := s.SaveAgent(protocol.Agent{ID: "agent-7", Name: "新", Runtime: "pi"})
	testkit.Eq(t, *saved.Look.Species, protocol.SpeciesFox, "a save without one is filled in too")
}
