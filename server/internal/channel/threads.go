package channel

import (
	"log"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

type threadSubject struct {
	kind  protocol.SubjectKind
	id    string
	owner string
}

// What a session's work is talked about under: the issue it works, so every session on one issue shares a thread; a
// session sent for no issue has a talk thread of its own.
func jobOf(h protocol.Session) threadSubject {
	if h.Issue != nil && *h.Issue != "" {
		return threadSubject{kind: protocol.SubjectKindIssue, id: *h.Issue, owner: h.ID}
	}
	return threadSubject{kind: protocol.SubjectKindTalk, id: h.ID, owner: h.ID}
}

func (c *Service) threadOf(subject threadSubject) *string {
	id, err := c.store().threadOfSubject(string(subject.kind), subject.id)
	if err != nil {
		log.Printf("chat: thread of %s %s: %v", subject.kind, subject.id, err)
		return nil
	}
	return id
}

// The one way from a session to its thread: through the issue it works, never by its own id, since the thread outlives it.
func (c *Service) threadOfSession(session string) *string {
	h := c.sessionOf(session)
	if h == nil {
		return nil
	}
	return c.threadOf(jobOf(*h))
}

// Who a thread's words are for, worked out now rather than kept: the session on the issue, or a talk thread's own session.
func (c *Service) ownerOf(conv chatConvRow) string {
	if conv.Kind != "thread" || conv.SubjectKind == nil || conv.SubjectID == nil || *conv.SubjectID == "" {
		return ""
	}
	switch protocol.SubjectKind(*conv.SubjectKind) {
	case protocol.SubjectKindIssue:
		if h := protocol.SessionOnIssue(c.core.State(), *conv.SubjectID); h != nil {
			return h.ID
		}
	case protocol.SubjectKindTalk:
		if c.sessionOf(*conv.SubjectID) != nil {
			return *conv.SubjectID
		}
	}
	return ""
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
