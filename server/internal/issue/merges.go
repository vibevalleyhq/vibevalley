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
	"vibevalley/internal/session"
)

// A branch that would conflict is not merged: the session stays with its branch and worktree, and the state says which files. A session told to resolve
// its conflict is looked at again when its run ends.

type merges struct {
	core     *core.Service
	chat     *channel.Service
	projects *project.Service
	sessions *session.Service
	stop     func()
}

func newMerges(core *core.Service, chat *channel.Service, projects *project.Service, sessions *session.Service) (*merges, error) {
	return &merges{core: core, chat: chat, projects: projects, sessions: sessions}, nil
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
					if session := m.core.Session(r.ID); session != nil && session.Conflict != nil {
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
	place, ok := m.sessions.Place(id)
	session := m.core.Session(id)
	if !ok || session == nil {
		return
	}
	base := ""
	if session.Conflict != nil {
		base = session.Conflict.Base
	}
	conflict := m.projects.Conflict(place, base)
	if !reflect.DeepEqual(session.Conflict, conflict) {
		m.core.Apply(protocol.FactConflict{ID: id, Conflict: conflict})
	}
}

// The owner asks the session to settle its conflicts: the ones the farm marked on it, else the ones merging would meet now.
func (m *merges) resolve(id string) error {
	session := m.core.Session(id)
	if session == nil {
		return protocol.Missing{What: "帮工 " + id}
	}
	conflict := session.Conflict
	if conflict == nil {
		changes, err := m.changes(id)
		if err != nil {
			return err
		}
		if changes != nil && len(changes.Conflicts) > 0 {
			conflict = &protocol.Conflict{Base: changes.Base, Files: changes.Conflicts}
		}
	}
	if conflict == nil {
		return protocol.Refused{Reason: session.Name + " 和主分支没有冲突"}
	}
	_, err := m.chat.TellSession("user", id, protocol.ConflictBrief(conflict.Base, conflict.Files))
	return err
}

// Changes are what the session's branch would bring; the game counts the owner's look, not the manager's.
func (m *merges) changesFor(id string, by protocol.Caller) (*protocol.Changes, error) {
	changes, err := m.changes(id)
	if err == nil && changes != nil && by == protocol.CallerOwner {
		m.core.Did(core.OwnerDid{Kind: core.OwnerReviewed, Session: id})
	}
	return changes, err
}

func (m *merges) changes(id string) (*protocol.Changes, error) {
	place, ok := m.sessions.Place(id)
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
	if session := m.core.Session(id); session != nil && !reflect.DeepEqual(session.Conflict, conflict) {
		m.core.Apply(protocol.FactConflict{ID: id, Conflict: conflict})
	}
	return &changes, nil
}

func (m *merges) merge(id string) (string, error) {
	session := m.core.Session(id)
	if session == nil {
		return "", protocol.Missing{What: "帮工 " + id}
	}
	merged, err := m.sessions.Merge(id)
	if err == nil {
		m.core.Notice(protocol.NoticeLevelInfo, fmt.Sprintf("收了 %s 的活：%s", session.Name, merged.Text))
		return merged.Text, nil
	}
	return "", m.mergeError(id, err)
}

func (m *merges) mergeError(id string, err error) error {
	session := m.core.Session(id)
	if session == nil {
		return err
	}
	failure, ok := err.(project.MergeFailure)
	if !ok {
		failure = project.MergeFailure{Kind: "error", Reason: err.Error()}
	}
	if failure.Kind == "conflict" {
		files := strings.Join(failure.Files, "、")
		m.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 的分支合进 %s 会冲突（%s），先没收。可以让它自己把冲突解决掉", session.Name, failure.Base, files))
		return protocol.Refused{Reason: fmt.Sprintf("没收：合进 %s 会冲突（%s）。%s 还在地里，分支和 worktree 都在。要它解决就用 tell 告诉它：%s", failure.Base, files, session.Name, protocol.ConflictBrief(failure.Base, failure.Files))}
	}
	if failure.Kind == "check" {
		if _, tellErr := m.chat.TellSession("user", id, failure.Reason+"\n请修好检查，再交回来。"); tellErr != nil {
			failure.Reason += "\n给帮工带话失败：" + tellErr.Error()
		}
	}
	m.core.Notice(protocol.NoticeLevelWarn, fmt.Sprintf("%s 的活没收进去：%s", session.Name, failure.Reason))
	return protocol.Refused{Reason: fmt.Sprintf("没收进去：%s。%s 还在地里", failure.Reason, session.Name)}
}
