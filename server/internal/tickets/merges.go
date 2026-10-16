package tickets

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	"vibevalley/internal/base"
	"vibevalley/internal/projects"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

// A branch that would conflict is not merged: the helper stays with its branch and worktree, and the state says which files. A helper told to resolve
// its conflict is looked at again when its turn ends.

type Merges struct {
	site     *base.Site
	projects *projects.Projects
	crew     *runs.Crew
	stop     func()
}

func newMerges(site *base.Site, projects *projects.Projects, crew *runs.Crew) (*Merges, error) {
	return &Merges{site: site, projects: projects, crew: crew}, nil
}

func (m *Merges) OnStart(ctx context.Context) error {
	_, events, stop := m.site.Events()
	m.stop = stop
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-events:
				if !ok {
					return
				}
				if r, ended := e.Value.(protocol.FactReport); ended {
					if helper := m.site.Helper(r.ID); helper != nil && helper.Conflict != nil {
						go m.recheck(r.ID)
					}
				}
			}
		}
	}()
	return nil
}

func (m *Merges) OnStop() {
	if m.stop != nil {
		m.stop()
	}
}

func (m *Merges) recheck(id string) {
	place, ok := m.crew.Place(id)
	helper := m.site.Helper(id)
	if !ok || helper == nil {
		return
	}
	base := ""
	if helper.Conflict != nil {
		base = helper.Conflict.Base
	}
	conflict := m.projects.Conflict(place, base)
	if !reflect.DeepEqual(helper.Conflict, conflict) {
		m.site.Apply(protocol.FactConflict{ID: id, Conflict: conflict})
	}
}

func (m *Merges) Changes(id string) (*protocol.Changes, error) {
	place, ok := m.crew.Place(id)
	if !ok {
		return nil, nil
	}
	changes, err := m.projects.Changes(place)
	if err != nil {
		return nil, err
	}
	// The preview is the freshest word on conflicts: the state follows it.
	var conflict *protocol.Conflict
	if len(changes.Conflicts) > 0 {
		conflict = &protocol.Conflict{Base: changes.Base, Files: changes.Conflicts}
	}
	if helper := m.site.Helper(id); helper != nil && !reflect.DeepEqual(helper.Conflict, conflict) {
		m.site.Apply(protocol.FactConflict{ID: id, Conflict: conflict})
	}
	return &changes, nil
}

func (m *Merges) Into(id, target string) ([]string, error) {
	place, ok := m.crew.Place(id)
	helper := m.site.Helper(id)
	if !ok || helper == nil {
		return nil, base.HarvestFailure{Kind: "error", Reason: fmt.Sprintf("没有 %s 这个帮工", id)}
	}
	if protocol.IsBusy(*helper) {
		return nil, base.HarvestFailure{Kind: "error", Reason: helper.Name + " 还在干活"}
	}
	// Close the session first, so nothing writes to the worktree while it is merged.
	m.crew.Rest(id)
	brought, err := m.projects.MergeInto(place, target)
	if err == nil {
		m.crew.Leave(id, protocol.IssueCloseMerged, 0)
		return brought, nil
	}
	if failure, ok := err.(base.HarvestFailure); ok && failure.Kind == "conflict" {
		m.site.Apply(protocol.FactConflict{ID: id, Conflict: &protocol.Conflict{Base: failure.Base, Files: failure.Files}})
	}
	return nil, err
}

func (m *Merges) Harvest(id string) string {
	place, ok := m.crew.Place(id)
	helper := m.site.Helper(id)
	if !ok || helper == nil {
		return fmt.Sprintf("没有 %s 这个帮工", id)
	}
	if helper.Playbook != nil {
		return fmt.Sprintf("%s 在做种植计划 %s 里的活：做完会自动合进计划分支，收获整个计划时再进主分支", helper.Name, helper.Playbook.ID)
	}
	if protocol.IsBusy(*helper) {
		return helper.Name + " 还在干活：等这一轮做完，或者先叫停，再收"
	}
	// Close the session first, so nothing writes to the worktree while it is merged.
	m.crew.Rest(id)
	merged, err := m.projects.Harvest(place)
	if err == nil {
		m.crew.Leave(id, protocol.IssueCloseHarvested, int64(merged.Commits))
		m.site.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("收了 %s 的活：%s", helper.Name, merged.Text))
		return merged.Text
	}
	failure, ok := err.(base.HarvestFailure)
	if !ok {
		failure = base.HarvestFailure{Kind: "error", Reason: err.Error()}
	}
	if failure.Kind == "conflict" {
		m.site.Apply(protocol.FactConflict{ID: id, Conflict: &protocol.Conflict{Base: failure.Base, Files: failure.Files}})
		files := strings.Join(failure.Files, "、")
		m.site.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 的分支合进 %s 会冲突（%s），先没收。可以让它自己把冲突解决掉", helper.Name, failure.Base, files))
		return fmt.Sprintf("没收：合进 %s 会冲突（%s）。%s 还在地里，分支和 worktree 都在。要它解决就用 tell 告诉它：%s", failure.Base, files, helper.Name, protocol.ConflictTask(failure.Base, failure.Files))
	}
	m.site.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 的活没收进去：%s", helper.Name, failure.Reason))
	return fmt.Sprintf("没收进去：%s。%s 还在地里", failure.Reason, helper.Name)
}
