package agent

import (
	"sync"
	"testing"

	"vibevalley/internal/protocol"
)

func TestCreationAllocatesDistinctIdentitiesInsideTheCommit(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const count = 12
	ids := make(chan string, count)
	skills := make(chan string, count)
	errs := make(chan error, count*2)
	var pending sync.WaitGroup
	for range count {
		pending.Go(func() {
			a, err := s.CreateAgent(protocol.Agent{Name: "同名", Runtime: "pi"})
			if err != nil {
				errs <- err
			} else {
				ids <- a.ID
			}
			k, err := s.CreateSkill(protocol.Skill{Name: "Same Skill"})
			if err != nil {
				errs <- err
			} else {
				skills <- k.ID
			}
		})
	}
	pending.Wait()
	close(ids)
	close(skills)
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	for _, all := range []chan string{ids, skills} {
		seen := map[string]bool{}
		for id := range all {
			if id == "" || seen[id] {
				t.Errorf("duplicate or empty id: %q", id)
			}
			seen[id] = true
		}
		if len(seen) != count {
			t.Fatalf("got %d identities", len(seen))
		}
	}
}

func TestCreateRejectsExplicitIdentityButSaveKeepsImportSemantics(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := protocol.Agent{ID: "imported", Name: "first", Runtime: "pi"}
	if _, err := s.CreateAgent(a); err == nil {
		t.Fatal("creation accepted an explicit identity")
	}
	if _, err := s.SaveAgent(a); err != nil {
		t.Fatal(err)
	}
	a.Name = "updated"
	if _, err := s.SaveAgent(a); err != nil {
		t.Fatal(err)
	}
	if s.Agent(a.ID).Name != "updated" {
		t.Fatal("save no longer updates the chosen identity")
	}
	if _, err := s.CreateSkill(protocol.Skill{ID: "imported"}); err == nil {
		t.Fatal("skill creation accepted an explicit identity")
	}
}

func TestSkillCreationOwnsSlugAndCollisions(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, id string }{{"Tests First!", "tests-first"}, {"先写测试", "skill"}, {"先写测试", "skill-2"}} {
		got, err := s.CreateSkill(protocol.Skill{Name: tc.name})
		if err != nil || got.ID != tc.id {
			t.Fatalf("%s: id=%s err=%v", tc.name, got.ID, err)
		}
	}
}
