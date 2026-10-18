package issue

import (
	"context"
	"slices"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

// What moving an issue to a status does. in_progress and in_review are the session's to reach, never the owner's.
type move int

const (
	moveNone    move = iota
	moveStart        // backlog → todo: sent out now, or waits in todo for room
	moveUnqueue      // todo → backlog
	moveRound        // in_review → todo: another round, with the owner's words
	moveReopen       // done, canceled → todo: a new session picks it up, with the owner's words
	moveRevive       // canceled before it was ever sent → backlog
	moveMerge        // in_review → done
	moveCancel       // in_progress, in_review → canceled: its session goes home
	moveDrop         // backlog, todo → canceled: never sent
)

// statusMove is the whole table; the refusal says why when there is no move.
func statusMove(t protocol.Issue, to protocol.IssueStatus) (move, string) {
	from := t.Status
	switch {
	case protocol.IsForManager(t):
		return moveNone, "这是派给管家的工单：管家答完就关"
	case t.Graph != nil || t.Task != nil || (t.Closed != nil && *t.Closed == protocol.IssueCloseMergedIntoGraph):
		return moveNone, "这是种植计划的工单，跟着计划走：在计划里改"
	case from == to:
		return moveNone, "它已经是这个状态了"
	case to == protocol.IssueStatusInProgress || to == protocol.IssueStatusInReview:
		return moveNone, "处理中和等你看是帮工干出来的：挪到待办，它就开工"
	}
	sent := len(t.Sessions) > 0
	switch from {
	case protocol.IssueStatusBacklog:
		switch to {
		case protocol.IssueStatusTodo:
			return moveStart, ""
		case protocol.IssueStatusCanceled:
			return moveDrop, ""
		}
	case protocol.IssueStatusTodo:
		switch to {
		case protocol.IssueStatusBacklog:
			return moveUnqueue, ""
		case protocol.IssueStatusCanceled:
			return moveDrop, ""
		}
	case protocol.IssueStatusInProgress:
		switch to {
		case protocol.IssueStatusCanceled:
			return moveCancel, ""
		}
		return moveNone, "帮工还在干：等它交回来，或者挪到已取消让它回家"
	case protocol.IssueStatusInReview:
		switch to {
		case protocol.IssueStatusTodo:
			return moveRound, ""
		case protocol.IssueStatusDone:
			return moveMerge, ""
		case protocol.IssueStatusCanceled:
			return moveCancel, ""
		}
	case protocol.IssueStatusDone, protocol.IssueStatusCanceled:
		switch {
		case to == protocol.IssueStatusTodo && sent:
			return moveReopen, ""
		case to == protocol.IssueStatusBacklog && !sent:
			return moveRevive, ""
		case sent:
			return moveNone, "关上的工单挪回待办，就是带一句话重开"
		}
		return moveNone, "没开过工就取消的工单，挪回备选再说"
	}
	return moveNone, "不能从" + statusWords[from] + "挪到" + statusWords[to]
}

var statusWords = map[protocol.IssueStatus]string{
	protocol.IssueStatusBacklog:    "备选",
	protocol.IssueStatusTodo:       "待办",
	protocol.IssueStatusInProgress: "处理中",
	protocol.IssueStatusInReview:   "等你看",
	protocol.IssueStatusDone:       "已完成",
	protocol.IssueStatusCanceled:   "已取消",
}

func statusMoves(t protocol.Issue) []protocol.IssueStatus {
	out := []protocol.IssueStatus{}
	for _, to := range protocol.IssueStatusValues {
		if m, _ := statusMove(t, to); m != moveNone {
			out = append(out, to)
		}
	}
	return out
}

func (s *Service) SetStatus(ctx context.Context, id string, to protocol.IssueStatus, text string, channel string) (protocol.Issue, error) {
	if !slices.Contains(protocol.IssueStatusValues, to) {
		return protocol.Issue{}, protocol.Refused{Reason: "没有这个状态：" + string(to)}
	}
	t, err := s.Get(id)
	if err != nil {
		return t, err
	}
	m, why := statusMove(t, to)
	text = str.Trim(text)
	switch m {
	case moveNone:
		return t, protocol.Refused{Reason: why}
	case moveStart:
		_, err = s.Start(ctx, id, channel)
	case moveUnqueue:
		_, err = s.Queue(id, false)
	case moveRound:
		if text == "" {
			return t, protocol.Refused{Reason: "再干一轮要说一句：这一轮要它做什么"}
		}
		err = s.Comment(id, protocol.CommentRequest{Text: text})
	case moveReopen:
		_, err = s.Reopen(ctx, id, text, channel)
	case moveRevive:
		err = s.issues.reopen(id)
	// The session's leaving closes the issue too, but later (issues.left): closed here, the answer already says so.
	case moveMerge:
		if _, err = s.Merge(id); err == nil {
			err = s.issues.closeAs(id, protocol.IssueCloseMerged)
		}
	case moveCancel:
		if err = s.Cancel(id); err == nil {
			err = s.issues.closeAs(id, protocol.IssueCloseDismissed)
		}
	case moveDrop:
		err = s.issues.drop(id)
	}
	if err != nil {
		return t, err
	}
	return s.Get(id)
}
