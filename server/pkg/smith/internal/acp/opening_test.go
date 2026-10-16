package acp

// Ported from tests/acp/acp-opening.test.ts. Go reads the boundary off the
// one reader (Opening.Notification for each notification as it arrives)
// instead of keying params objects by identity.

import "testing"

func TestOpeningRefusedOrUnrelatedAnswersDoNotMarkNotificationsLive(t *testing.T) {
	for _, tc := range []struct {
		name   string
		id     string
		result bool
	}{
		{"unrelated response", "2", true},
		{"refused open", "1", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opening := NewOpening()
			opening.Outgoing("1", MethodSessionResume)
			opening.Response(tc.id, tc.result)
			if opening.Notification() {
				t.Fatal("a notification after this answer must not be live")
			}
		})
	}
}

func TestOpeningInitializeAnswerDoesNotOpenASession(t *testing.T) {
	opening := NewOpening()
	opening.Outgoing("1", MethodInitialize)
	opening.Response("1", true)
	if opening.Notification() {
		t.Fatal("an initialize answer opened nothing")
	}
	if NewOpening().Notification() {
		t.Fatal("nothing opened yet")
	}
}

func TestOpeningSessionAnswerMarksLaterNotificationsLive(t *testing.T) {
	opening := NewOpening()
	opening.Outgoing("4", MethodSessionNew)
	if opening.Notification() {
		t.Fatal("before the answer")
	}
	opening.Response("4", true)
	if !opening.Notification() {
		t.Fatal("after the session/new answer")
	}
}
