package handler

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/workspace"
	"vibevalley/pkg/x/ptr"
)

type api struct{ f *workspace.Workspace }

var _ protocol.Handlers = api{}

func refused(err error) error {
	if err == nil {
		return nil
	}
	var tagged protocol.StatusError
	if errors.As(err, &tagged) {
		return err
	}
	return protocol.Refused{Reason: err.Error()}
}

func missing(what string) error { return protocol.Missing{What: what} }

func (a api) session(id string) error {
	if a.f.Session.Find(id) == nil {
		return missing("帮工 " + id)
	}
	return nil
}

func (a api) ServerHealth(context.Context) (protocol.Health, error) {
	return protocol.Health{Ok: true, Version: a.f.Version}, nil
}

func (a api) ManagerOpen(context.Context) error { a.f.Core.Open(); return nil }

func (a api) SettingLoad(context.Context) (protocol.SettingsStatus, error) {
	return a.f.Setting.Status(), nil
}

func (a api) SettingCheck(_ context.Context, body protocol.SettingsUpdate) (protocol.SettingsCheck, error) {
	return a.f.Setting.Check(body), nil
}

func (a api) SettingSave(_ context.Context, body protocol.SettingsUpdate) (protocol.SettingsStatus, error) {
	s, err := a.f.Setting.Save(body)
	return s, refused(err)
}

func (a api) ChannelSay(ctx context.Context, body protocol.SayRequest) error {
	if body.Bed != nil {
		a.f.Game.Want(*body.Bed)
	}
	a.f.Core.Open()
	return refused(a.f.Manager.Say(ctx, body.Text, ptr.Value(body.Agent), body.Conversation))
}

func (a api) ChannelCreate(_ context.Context, body protocol.ChannelRequest) error {
	_, err := a.f.Channel.OpenChannel(body.Name, ptr.Value(body.Description), ptr.Value(body.Project))
	return refused(err)
}

func (a api) ScheduleCreate(_ context.Context, body protocol.ScheduleRequest) (protocol.Schedule, error) {
	s, err := a.f.Schedule.Add(body)
	return s, refused(err)
}

func (a api) ScheduleList(context.Context) ([]protocol.Schedule, error) {
	return a.f.Schedule.List(), nil
}

func (a api) ScheduleUpdate(_ context.Context, id string, body protocol.ScheduleUpdate) error {
	if body.Enabled == nil {
		return nil
	}
	_, err := a.f.Schedule.SetEnabled(id, *body.Enabled)
	return refused(err)
}

func (a api) ScheduleDelete(_ context.Context, id string) error {
	_, err := a.f.Schedule.Remove(id)
	return refused(err)
}

func (a api) ChannelUpdate(_ context.Context, id string, body protocol.ChannelUpdate) error {
	return refused(a.f.Channel.UpdateChannel(id, body.Description, body.Project))
}

func (a api) ManagerHear(_ context.Context, body protocol.SayRequest) error {
	a.f.Core.Open()
	a.f.Manager.Heard(body.Text, ptr.Value(body.Agent))
	return nil
}

func (a api) IssueComment(_ context.Context, id string, body protocol.CommentRequest) error {
	return refused(a.f.Issue.Comment(id, body))
}

func (a api) IssueChanges(_ context.Context, id string) (protocol.Changes, error) {
	changes, err := a.f.Issue.Changes(id, protocol.CallerOwner)
	return changes, refused(err)
}

func (a api) IssueMerge(_ context.Context, id string) error {
	_, err := a.f.Issue.Merge(id)
	return refused(err)
}

func (a api) IssueResolve(_ context.Context, id string) error {
	return refused(a.f.Issue.Resolve(id))
}

func (a api) IssueCancel(_ context.Context, id string) error {
	return refused(a.f.Issue.Cancel(id))
}

func (a api) SessionStop(_ context.Context, id string) error {
	if err := a.session(id); err != nil {
		return err
	}
	a.f.Session.Stop(id)
	return nil
}

func (a api) SessionList(_ context.Context, agent *string) ([]protocol.Session, error) {
	return a.f.Session.List(ptr.Value(agent)), nil
}

func (a api) SessionGet(_ context.Context, id string) (protocol.Session, error) {
	if s := a.f.Session.Get(id); s != nil {
		return *s, nil
	}
	return protocol.Session{}, missing("帮工 " + id)
}

func (a api) SessionEvents(_ context.Context, id string, run *string) ([]protocol.SessionEvent, error) {
	return a.f.Session.Events(id, ptr.Value(run)), nil
}

func (a api) PlaybookPlan(_ context.Context, body protocol.PlanRequest) (string, error) {
	s, err := a.f.Playbook.Plan(body.Goal, body.Project, ptr.Value(body.Agent), protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) PlaybookUpdateNode(_ context.Context, id, node string, body protocol.NodeEdit) (string, error) {
	s, err := a.f.Playbook.EditNode(id, node, body, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) PlaybookDeleteNode(_ context.Context, id, node string) (string, error) {
	s, err := a.f.Playbook.RemoveNode(id, node, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) PlaybookAct(_ context.Context, id string, body protocol.PlaybookActRequest) (string, error) {
	s, err := a.f.Playbook.Act(id, body.Action, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) PlaybookNodeAct(_ context.Context, id, node string, body protocol.NodeActRequest) (string, error) {
	s, err := a.f.Playbook.NodeAct(id, node, body.Action, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) ChannelHistory(_ context.Context, id string, before, limit *int64) ([]protocol.ChatMessage, error) {
	messages, err := a.f.Channel.History(id, before, limit)
	if err != nil {
		return nil, missing(err.Error())
	}
	return messages, nil
}

func (a api) ChannelMarkRead(_ context.Context, id string, body protocol.ChatReadRequest) error {
	if err := a.f.Channel.MarkRead(id, body.Number); err != nil {
		return missing(err.Error())
	}
	return nil
}

func (a api) PlaybookChanges(_ context.Context, id string) (protocol.Changes, error) {
	c, err := a.f.Playbook.Changes(id)
	return c, refused(err)
}

func (a api) PlaybookEvents(_ context.Context, id string) ([]protocol.PlaybookEvent, error) {
	return a.f.Playbook.Events(id), nil
}

func (a api) GameChooseTitle(_ context.Context, body protocol.ChooseTitleRequest) error {
	a.f.Game.ChooseTitle(body.Achievement, body.Tier)
	return nil
}

func (a api) RuntimeList(ctx context.Context) ([]protocol.RuntimeInfo, error) {
	return a.f.Runtime.List(ctx), nil
}

func (a api) RuntimeRefresh(ctx context.Context, id string) (protocol.RuntimeInfo, error) {
	if info := a.f.Runtime.Refresh(ctx, id); info != nil {
		return *info, nil
	}
	return protocol.RuntimeInfo{}, missing("runtime " + id)
}

func (a api) RuntimeUpdate(ctx context.Context, id string, body protocol.RuntimeSettings) (protocol.RuntimeInfo, error) {
	info, err := a.f.Runtime.Update(ctx, id, body)
	if err != nil {
		return protocol.RuntimeInfo{}, err
	}
	if info != nil {
		return *info, nil
	}
	return protocol.RuntimeInfo{}, missing("runtime " + id)
}

func (a api) RuntimeUpgrade(context.Context, string) (protocol.RuntimeInfo, error) {
	return protocol.RuntimeInfo{}, protocol.Refused{Reason: "升级会改动这台机器：请在终端里用这个 runtime 自己的升级命令"}
}

func (a api) AgentList(context.Context) ([]protocol.Agent, error) {
	return a.f.Agent.All(), nil
}

func (a api) AgentSave(_ context.Context, id string, body protocol.Agent) (protocol.Agent, error) {
	if body.ID != id {
		return protocol.Agent{}, protocol.Refused{Reason: "路径里的档案 " + id + " 和请求里的 " + body.ID + " 不是一个"}
	}
	saved, err := a.f.Agent.SaveAgent(body)
	return saved, refused(err)
}

func (a api) AgentDelete(_ context.Context, id string) error { return a.f.Agent.DeleteAgent(id) }

func (a api) ProjectCheck(_ context.Context, body protocol.NewProject) (protocol.ProjectCheck, error) {
	return a.f.Project.Check(body), nil
}

func (a api) AgentCheck(ctx context.Context, body protocol.AgentCheckRequest) ([]protocol.AgentCheck, error) {
	out := make([]protocol.AgentCheck, len(body.Agents))
	for i, agent := range body.Agents {
		out[i] = protocol.AgentCheck{ID: agent.ID, Issues: a.f.Runtime.Check(ctx, agent)}
	}
	return out, nil
}

func (a api) MemoryList(_ context.Context, agent string) (protocol.MemoryList, error) {
	return a.f.Memory.MemoriesOf(agent), nil
}

func (a api) MemoryRecall(_ context.Context, agent string, project, text *string) (protocol.RecallPreview, error) {
	return a.f.Memory.RecallOf(agent, ptr.Value(project), ptr.Value(text))
}

func (a api) MemoryCreate(_ context.Context, agent string, body protocol.MemoryRequest) (protocol.Memory, error) {
	m, err := a.f.Memory.Remember(agent, body.Text, ptr.Value(body.Project))
	return m, refused(err)
}

func (a api) MemoryDelete(_ context.Context, agent, memory string) error {
	return refused(a.f.Memory.ForgetOf(agent, memory))
}

func (a api) ManagerListArchive(_ context.Context, q *string) (protocol.ArchiveListing, error) {
	return a.f.Memory.Archive(ptr.Value(q)), nil
}

func (a api) ManagerGetArchive(_ context.Context, name string) (string, error) {
	if text, ok := a.f.Memory.ArchiveFile(name); ok {
		return text, nil
	}
	return "", missing("旧账 " + name)
}

func (a api) SkillList(context.Context) ([]protocol.Skill, error) { return a.f.Agent.Skills(), nil }

func (a api) SkillSave(_ context.Context, id string, body protocol.Skill) (protocol.Skill, error) {
	if body.ID != id {
		return protocol.Skill{}, protocol.Refused{Reason: "路径里的技能 " + id + " 和请求里的 " + body.ID + " 不是一个"}
	}
	return a.f.Agent.SaveSkill(body)
}

func (a api) SkillDelete(_ context.Context, id string) error { return a.f.Agent.DeleteSkill(id) }

func (a api) ProjectList(ctx context.Context) ([]protocol.ProjectSummary, error) {
	return a.f.Project.Summaries(ctx), nil
}

func (a api) ProjectCreate(_ context.Context, body protocol.NewProject) (protocol.ProjectSummary, error) {
	p, err := a.f.Project.Create(body)
	if err != nil {
		return protocol.ProjectSummary{}, refused(err)
	}
	return a.f.Project.Summary(p), nil
}

func (a api) ProjectLanguages(ctx context.Context, id string) (protocol.ProjectLanguages, error) {
	langs, err := a.f.Project.Languages(ctx, id)
	if err != nil {
		return protocol.ProjectLanguages{}, refused(err)
	}
	if langs == nil {
		return protocol.ProjectLanguages{}, missing("项目 " + id)
	}
	return *langs, nil
}

func (a api) ProjectActivity(ctx context.Context, id string) (protocol.ProjectActivity, error) {
	if act := a.f.Project.Activity(ctx, id); act != nil {
		return *act, nil
	}
	return protocol.ProjectActivity{}, missing("项目 " + id)
}

// The voice endpoints log each step of a call and why one failed (never a token or a key): a call that goes wrong is
// read back from the server's log.

func (a api) VoiceSession(ctx context.Context) (protocol.AgoraTicket, error) {
	s, err := a.f.Voice.Session(ctx)
	voiceLog("session", s.Channel, err)
	return s, err
}

func (a api) VoiceRenew(ctx context.Context, body protocol.RenewRequest) (protocol.AgoraTicket, error) {
	s, err := a.f.Voice.Renew(ctx, body.Channel, body.UID)
	voiceLog("renew", body.Channel, err)
	return s, err
}

func (a api) VoiceStart(ctx context.Context, body protocol.StartRequest) (protocol.VoiceAgent, error) {
	started := time.Now()
	agent, err := a.f.Voice.Start(ctx, body.Channel, body.UID)
	voiceLog(fmt.Sprintf("agent start (%d ms) %s", time.Since(started).Milliseconds(), agent.AgentID), body.Channel, err)
	return agent, err
}

func (a api) VoiceDictate(ctx context.Context, body protocol.DictateRequest) (protocol.Dictated, error) {
	return a.f.Voice.Dictate(ctx, body.Audio, body.Format)
}

func (a api) VoiceSaid(ctx context.Context, body protocol.VoiceSaid) error {
	return a.f.Voice.Said(body.AgentID, body.Text)
}

func (a api) VoiceStop(ctx context.Context, body protocol.VoiceAgent) error {
	err := a.f.Voice.Stop(ctx, body.AgentID)
	voiceLog("agent stop "+body.AgentID, "", err)
	return err
}

func voiceLog(what, channel string, err error) {
	if err != nil {
		log.Printf("vibevalley voice: %s %s failed: %v", what, channel, err)
		return
	}
	log.Printf("vibevalley voice: %s %s", what, channel)
}

func (a api) ConnectorList(context.Context) ([]protocol.ConnectorStatus, error) {
	return a.f.Connector.List(), nil
}

func (a api) ConnectorLogin(_ context.Context, id protocol.ConnectorID, body protocol.ConnectorLogin) (protocol.ConnectorStatus, error) {
	return a.f.Connector.Login(id, body), nil
}

func (a api) ConnectorVerify(_ context.Context, id protocol.ConnectorID, body protocol.VerifyRequest) (protocol.ConnectorStatus, error) {
	return a.f.Connector.Verify(id, body.Code), nil
}

func (a api) ConnectorLogout(_ context.Context, id protocol.ConnectorID) (protocol.ConnectorStatus, error) {
	return a.f.Connector.Logout(id), nil
}

func (a api) ConnectorChannel(_ context.Context, id protocol.ConnectorID, body protocol.ConnectorsChannelRequest) (protocol.ConnectorStatus, error) {
	s, err := a.f.Connector.SetChannel(id, body.Channel)
	if err != nil {
		return s, protocol.ConnectorRefused{Reason: err.Error()}
	}
	return s, nil
}

func (a api) GateStatus(context.Context) (protocol.LanStatus, error) { return a.f.Gate.Status(), nil }

func (a api) GateUpdate(_ context.Context, body protocol.SetOpenRequest) (protocol.LanStatus, error) {
	return a.f.Gate.SetOpen(body.Open)
}

func (a api) GateStartPairing(context.Context) (protocol.LanStatus, error) {
	return a.f.Gate.StartPairing()
}

func (a api) GateStopPairing(context.Context) (protocol.LanStatus, error) {
	return a.f.Gate.StopPairing(), nil
}

func (a api) GateAnswerPairing(_ context.Context, body protocol.AnswerPairingRequest) (protocol.LanStatus, error) {
	return a.f.Gate.Answer(body.Allow)
}

func (a api) GateDeleteDevice(_ context.Context, id string) (protocol.LanStatus, error) {
	return a.f.Gate.Forget(id)
}

func (a api) GatePair(ctx context.Context, body protocol.LanPairRequest) (protocol.LanPaired, error) {
	return a.f.Gate.Pair(ctx, body.Code, body.Name)
}

func (a api) GateMe(ctx context.Context) (protocol.LanDevice, error) { return a.f.Gate.Me(ctx) }

func (a api) IssueReopen(ctx context.Context, id string, body protocol.ReopenRequest) (protocol.Dispatched, error) {
	session, err := a.f.Issue.Reopen(context.WithoutCancel(ctx), id, body.Text, a.f.Channel.General())
	if err != nil {
		return protocol.Dispatched{}, refused(err)
	}
	return protocol.Dispatched{Session: &session}, nil
}

func (a api) IssueList(context.Context) ([]protocol.Issue, error) { return a.f.Issue.List() }

func (a api) IssueGet(_ context.Context, id string) (protocol.Issue, error) {
	return a.f.Issue.Get(id)
}

func (a api) IssueRuns(_ context.Context, id string) ([]protocol.Run, error) {
	if _, err := a.f.Issue.Get(id); err != nil {
		return nil, err
	}
	return a.f.Session.Runs(id)
}

func (a api) IssueCreate(_ context.Context, body protocol.IssueRequest) (protocol.Issue, error) {
	return a.f.Issue.Add(body)
}

func (a api) IssueUpdate(_ context.Context, id string, body protocol.IssueUpdate) (protocol.Issue, error) {
	return a.f.Issue.Edit(id, body)
}

func (a api) IssueMove(_ context.Context, id string, body protocol.MoveIssueRequest) ([]protocol.Issue, error) {
	return a.f.Issue.Move(id, ptr.Value(body.Before))
}

func (a api) IssueDelete(_ context.Context, id string) error { return a.f.Issue.Remove(id) }

func (a api) IssueStart(ctx context.Context, id string) (protocol.Dispatched, error) {
	got, err := a.f.Issue.Start(context.WithoutCancel(ctx), id, a.f.Channel.General())
	return got, refused(err)
}

func (a api) IssueUnqueue(_ context.Context, id string) (protocol.Issue, error) {
	return a.f.Issue.Queue(id, false)
}
