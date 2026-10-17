package channel

import (
	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

type threadSubject struct {
	kind  protocol.SubjectKind
	id    string
	owner string
}

// Called inside the parent's transaction: a thread and its initial owner appear together.
func (s chatStore) threadFor(parent chatMsgRow, subject threadSubject) (string, error) {
	if existing, err := s.threadByParent(parent.ID); err != nil {
		return "", err
	} else if existing != nil {
		return *existing, nil
	}
	id := base.NewID()
	kind := string(subject.kind)
	var subjectID *string
	if subject.id != "" {
		subjectID = &subject.id
	}
	if err := s.createThread(id, parent.ID, parent.Number, &kind, subjectID, parent.Conversation, clock.NowMs()); err != nil {
		return "", err
	}
	if subject.owner != "" {
		if err := s.follow(id, subject.owner, "owner", parent.Number); err != nil {
			return "", err
		}
	}
	return id, nil
}
