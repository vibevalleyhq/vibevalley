package issue

import (
	"context"
	"fmt"
	"reflect"
	"strings"

	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
	"vibevalley/internal/worker"
)

// A branch that would conflict is not merged: the worker stays with its branch and worktree, and the state says which files. A worker told to resolve
// its conflict is looked at again when its run ends.

type merges struct {
	core     *core.Service
	chat     *channel.Service
	projects *project.Service
	workers  *worker.Service
	stop     func()
}

func newMerges(core *core.Service, chat *channel.Service, projects *project.Service, workers *worker.Service) (*merges, error) {
	return &merges{core: core, chat: chat, projects: projects, workers: workers}, nil
}

func (m *merges) OnStart(ctx context.Context) error {
	_, events, stop := m.core.Events()
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
				// In this loop, one at a time: two rechecks side by side could land in the wrong order.
				if r, ended := e.Value.(protocol.FactReport); ended {
					if worker := m.core.Worker(r.ID); worker != nil && worker.Conflict != nil {
						m.recheck(r.ID)
					}
				}
			}
		}
	}()
	return nil
}

func (m *merges) OnStop() {
	if m.stop != nil {
		m.stop()
	}
}

func (m *merges) recheck(id string) {
	place, ok := m.workers.Place(id)
	worker := m.core.Worker(id)
	if !ok || worker == nil {
		return
	}
	base := ""
	if worker.Conflict != nil {
		base = worker.Conflict.Base
	}
	conflict := m.projects.Conflict(place, base)
	if !reflect.DeepEqual(worker.Conflict, conflict) {
		m.core.Apply(protocol.FactConflict{ID: id, Conflict: conflict})
	}
}

// The owner asks the worker to settle its conflicts: the ones the farm marked on it, else the ones merging would meet now.
func (m *merges) Resolve(id string) error {
	worker := m.core.Worker(id)
	if worker == nil {
		return protocol.Missing{What: "帮工 " + id}
	}
	conflict := worker.Conflict
	if conflict == nil {
		if changes, err := m.changes(id); err == nil && changes != nil && len(changes.Conflicts) > 0 {
			conflict = &protocol.Conflict{Base: changes.Base, Files: changes.Conflicts}
		}
	}
	if conflict == nil {
		return protocol.Refused{Reason: worker.Name + " 和主分支没有冲突"}
	}
	_, err := m.chat.TellWorker("user", id, protocol.ConflictTask(conflict.Base, conflict.Files))
	return err
}

// Changes are what the worker's branch would bring; the game counts the owner's look, not the manager's.
func (m *merges) Changes(id string, by protocol.Caller) (*protocol.Changes, error) {
	changes, err := m.changes(id)
	if err == nil && changes != nil && by == protocol.CallerOwner {
		m.core.Did(core.OwnerDid{Kind: core.OwnerReviewed, Worker: id})
	}
	return changes, err
}

func (m *merges) changes(id string) (*protocol.Changes, error) {
	place, ok := m.workers.Place(id)
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
	if worker := m.core.Worker(id); worker != nil && !reflect.DeepEqual(worker.Conflict, conflict) {
		m.core.Apply(protocol.FactConflict{ID: id, Conflict: conflict})
	}
	return &changes, nil
}

func (m *merges) Into(id, target string) ([]string, error) {
	place, ok := m.workers.Place(id)
	worker := m.core.Worker(id)
	if !ok || worker == nil {
		return nil, project.MergeFailure{Kind: "error", Reason: fmt.Sprintf("没有 %s 这个帮工", id)}
	}
	if protocol.IsBusy(*worker) {
		return nil, project.MergeFailure{Kind: "error", Reason: worker.Name + " 还在干活"}
	}
	// Close the session first, so nothing writes to the worktree while it is merged.
	m.workers.Rest(id)
	brought, err := m.projects.MergeInto(place, target)
	if err == nil {
		m.workers.Leave(id, protocol.IssueCloseMergedIntoPlan, 0)
		return brought, nil
	}
	if failure, ok := err.(project.MergeFailure); ok && failure.Kind == "conflict" {
		m.core.Apply(protocol.FactConflict{ID: id, Conflict: &protocol.Conflict{Base: failure.Base, Files: failure.Files}})
	}
	return nil, err
}

func (m *merges) Merge(id string) string {
	place, ok := m.workers.Place(id)
	worker := m.core.Worker(id)
	if !ok || worker == nil {
		return fmt.Sprintf("没有 %s 这个帮工", id)
	}
	if worker.Playbook != nil {
		return fmt.Sprintf("%s 在做种植计划 %s 里的活：做完会自动合进计划分支，收获整个计划时再进主分支", worker.Name, worker.Playbook.ID)
	}
	if protocol.IsBusy(*worker) {
		return worker.Name + " 还在干活：等这一轮做完，或者先叫停，再收"
	}
	// Close the session first, so nothing writes to the worktree while it is merged.
	m.workers.Rest(id)
	merged, err := m.projects.Merge(place)
	if err == nil {
		m.workers.Leave(id, protocol.IssueCloseMerged, int64(merged.Commits))
		m.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("收了 %s 的活：%s", worker.Name, merged.Text))
		return merged.Text
	}
	failure, ok := err.(project.MergeFailure)
	if !ok {
		failure = project.MergeFailure{Kind: "error", Reason: err.Error()}
	}
	if failure.Kind == "conflict" {
		m.core.Apply(protocol.FactConflict{ID: id, Conflict: &protocol.Conflict{Base: failure.Base, Files: failure.Files}})
		files := strings.Join(failure.Files, "、")
		m.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 的分支合进 %s 会冲突（%s），先没收。可以让它自己把冲突解决掉", worker.Name, failure.Base, files))
		return fmt.Sprintf("没收：合进 %s 会冲突（%s）。%s 还在地里，分支和 worktree 都在。要它解决就用 tell 告诉它：%s", failure.Base, files, worker.Name, protocol.ConflictTask(failure.Base, failure.Files))
	}
	m.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 的活没收进去：%s", worker.Name, failure.Reason))
	return fmt.Sprintf("没收进去：%s。%s 还在地里", failure.Reason, worker.Name)
}
