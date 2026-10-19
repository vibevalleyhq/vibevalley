package handler

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"vibevalley/internal/manager"
	"vibevalley/internal/memory"
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

func (a api) ManagerStop(context.Context) error { a.f.Manager.Stop(); return nil }

func (a api) SettingLoad(context.Context) (protocol.SettingsStatus, error) {
	return a.f.Setting.Status(), nil
}

func (a api) SettingCheck(_ context.Context, body protocol.SettingsUpdate) (protocol.SettingsCheck, error) {
	s := a.f.Setting.Check(body)
	github := a.f.Project.GitHubStatus()
	s.GitHub = &github
	return s, nil
}

func (a api) GithubStatus(context.Context) (protocol.GitHubStatus, error) {
	return a.f.Project.GitHubStatus(), nil
}

func (a api) GithubRefresh(ctx context.Context) (protocol.GitHubStatus, error) {
	status := a.f.Project.RefreshGitHub(ctx)
	return status, a.f.Issue.RefreshPullRequests(ctx)
}

func (a api) SettingSave(_ context.Context, body protocol.SettingsUpdate) (protocol.SettingsStatus, error) {
	s, err := a.f.Setting.Save(body)
	return s, refused(err)
}

func (a api) ChannelSay(ctx context.Context, body protocol.SayRequest) error {
	if body.Station != nil {
		a.f.Game.Want(*body.Station)
	}
	a.f.Core.Open()
	pick := manager.Pick{Agent: ptr.Value(body.Agent), Project: ptr.Value(body.Project)}
	return refused(a.f.Manager.Say(ctx, body.Text, pick, body.Conversation, ptr.Value(body.SendKey)))
}

func (a api) ChannelCreate(_ context.Context, body protocol.ChannelRequest) (string, error) {
	channel, err := a.f.Channel.OpenChannel(body.Name, ptr.Value(body.Description), ptr.Value(body.Project))
	return channel.ID, refused(err)
}

func (a api) ScheduleCreate(_ context.Context, body protocol.ScheduleRequest) (protocol.Schedule, error) {
	s, err := a.f.Schedule.Add(body, protocol.ScheduleByOwner, true)
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
	return refused(a.f.Voice.HeardCurrent(body.Text, ptr.Value(body.Agent), ptr.Value(body.SendKey)))
}

func (a api) IssueComment(_ context.Context, id string, body protocol.CommentRequest) error {
	return refused(a.f.Issue.Comment(id, body))
}

func (a api) IssueChanges(_ context.Context, id string) (protocol.Changes, error) {
	changes, err := a.f.Issue.Changes(id, protocol.CallerOwner)
	return changes, refused(err)
}

func (a api) IssueResolve(_ context.Context, id string) error {
	return refused(a.f.Issue.Resolve(id))
}

func (a api) SessionStop(_ context.Context, id string) error {
	if err := a.session(id); err != nil {
		return err
	}
	a.f.Session.Stop(id)
	return nil
}

func (a api) SessionList(_ context.Context, agent *string) ([]protocol.Session, error) {
	return a.f.Session.List(ptr.Value(agent))
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

func (a api) GraphSplit(_ context.Context, body protocol.GraphSplitRequest) (string, error) {
	s, err := a.f.Task.Split(body.Goal, body.Project, ptr.Value(body.Agent), protocol.GraphActorUser)
	return s, refused(err)
}

func (a api) GraphUpdateTask(_ context.Context, id, node string, body protocol.TaskEdit) (string, error) {
	s, err := a.f.Task.EditTask(id, node, body, protocol.GraphActorUser)
	return s, refused(err)
}

func (a api) GraphDeleteTask(_ context.Context, id, node string) (string, error) {
	s, err := a.f.Task.RemoveTask(id, node, protocol.GraphActorUser)
	return s, refused(err)
}

func (a api) GraphAct(_ context.Context, id string, body protocol.GraphActRequest) (string, error) {
	s, err := a.f.Task.Act(id, body.Action, protocol.GraphActorUser)
	return s, refused(err)
}

func (a api) GraphTaskAct(_ context.Context, id, node string, body protocol.TaskActRequest) (string, error) {
	s, err := a.f.Task.TaskAct(id, node, body.Action, protocol.GraphActorUser)
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

func (a api) GraphChanges(_ context.Context, id string) (protocol.Changes, error) {
	c, err := a.f.Task.Changes(id)
	return c, refused(err)
}

func (a api) GraphEvents(_ context.Context, id string) ([]protocol.GraphEvent, error) {
	return a.f.Task.Events(id), nil
}

func (a api) GameAchievements(context.Context) ([]protocol.Achievement, error) {
	return a.f.Game.Achievements(), nil
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

func (a api) AgentList(context.Context) ([]protocol.Agent, error) {
	return a.f.Agent.All(), nil
}

func (a api) AgentCreate(_ context.Context, body protocol.Agent) (protocol.Agent, error) {
	return a.f.Agent.CreateAgent(body)
}

func (a api) SkillCreate(_ context.Context, body protocol.Skill) (protocol.Skill, error) {
	return a.f.Agent.CreateSkill(body)
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
	m, err := a.f.Memory.Remember(memory.Note{Agent: agent, Text: body.Text, Project: ptr.Value(body.Project), By: protocol.MemoryAuthorOwner})
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

func (a api) ManagerMarkWrong(_ context.Context, body protocol.ManagerEvalRequest) (protocol.ManagerEval, error) {
	eval, err := a.f.Manager.MarkWrong(body.On, body.Want)
	return eval, refused(err)
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

func (a api) ProjectTemplates(_ context.Context, id string) (protocol.ProjectTemplates, error) {
	return a.f.Issue.Templates(id)
}

func (a api) ProjectActivity(ctx context.Context, id string) (protocol.ProjectActivity, error) {
	if act := a.f.Project.Activity(ctx, id); act != nil {
		return *act, nil
	}
	return protocol.ProjectActivity{}, missing("项目 " + id)
}

// The voice endpoints log each step of a call and why one failed (never a token or a key): a call that goes wrong is
// read back from the server's log.

func (a api) VoiceSession(ctx context.Context) (protocol.AgoraGrant, error) {
	s, err := a.f.Voice.Session(ctx)
	voiceLog("session", s.Channel, err)
	return s, err
}

func (a api) VoiceRenew(ctx context.Context, body protocol.RenewRequest) (protocol.AgoraGrant, error) {
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

func (a api) VoiceHeard(_ context.Context, body protocol.VoiceHeard) error {
	return refused(a.f.Voice.Heard(body.AgentID, body.Text, ptr.Value(body.Agent), ptr.Value(body.SendKey)))
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

func (a api) IssueList(context.Context) ([]protocol.Issue, error) { return a.f.Issue.List() }

func (a api) IssueHistory(context.Context) ([]protocol.IssueHistory, error) {
	return a.f.Issue.History()
}

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

func (a api) IssueAccept(ctx context.Context, id string, body protocol.IssueAcceptRequest) (protocol.Issue, error) {
	got, err := a.f.Issue.Accept(context.WithoutCancel(ctx), id, body)
	return got, refused(err)
}

func (a api) IssueDraft(ctx context.Context, id string, body protocol.IssueDraftRequest) (protocol.Issue, error) {
	got, err := a.f.Issue.Draft(context.WithoutCancel(ctx), id, body.Text, a.f.Channel.General())
	return got, refused(err)
}

func (a api) IssueDispatch(ctx context.Context, id string, body protocol.IssueDispatchRequest) (protocol.Dispatched, error) {
	if body.Station != nil {
		a.f.Game.Want(*body.Station)
	}
	got, err := a.f.Issue.DispatchQueued(context.WithoutCancel(ctx), id)
	return got, refused(err)
}

func (a api) IssueStatus(ctx context.Context, id string, body protocol.IssueStatusRequest) (protocol.Issue, error) {
	got, err := a.f.Issue.SetStatus(context.WithoutCancel(ctx), id, body.Status, body.Text, a.f.Channel.General())
	return got, refused(err)
}
