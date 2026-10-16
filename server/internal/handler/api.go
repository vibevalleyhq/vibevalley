package handler

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strconv"
	"time"

	"vibevalley/internal/farm"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

// VibeValleyApi, answered (ported from the TypeScript server's main.ts's handlers, removed): each forwards to the service that owns the rule, and turns
// a refusal into FarmRefused, a missing thing into FarmMissing.

type api struct{ f *farm.Farm }

var _ protocol.Handlers = api{}

func refused(err error) error {
	if err == nil {
		return nil
	}
	var tagged protocol.StatusError
	if errors.As(err, &tagged) {
		return err
	}
	return protocol.FarmRefused{Reason: err.Error()}
}

func missing(what string) error { return protocol.FarmMissing{What: what} }

func number(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, protocol.FarmMissing{What: s}
	}
	return n, nil
}

func optNumber(s *string) *int64 {
	if s == nil {
		return nil
	}
	n, err := strconv.ParseInt(*s, 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func str(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// open starts the day when it has not started: typing before 开工, as on the mock.
func (a api) open() {
	if a.f.Site.Call() != protocol.CallStateLive {
		a.f.Site.SetCall(protocol.CallStateLive, "")
	}
}

func (a api) worker(id string) error {
	if a.f.Crew.Find(id) == nil {
		return missing("帮工 " + id)
	}
	return nil
}

func (a api) FarmHealth(context.Context) (protocol.Health, error) {
	return protocol.Health{Ok: true, Version: a.f.Version}, nil
}

func (a api) FarmStart(context.Context) error { a.open(); return nil }

func (a api) FarmSettings(context.Context) (protocol.SettingsStatus, error) {
	return a.f.Settings.Status(), nil
}

func (a api) FarmSaveSettings(_ context.Context, body protocol.SettingsUpdate) (protocol.SettingsStatus, error) {
	s, err := a.f.Settings.Save(body)
	return s, refused(err)
}

func (a api) FarmEnd(context.Context) error {
	a.f.Crew.DismissAll()
	a.f.Site.SetCall(protocol.CallStateIdle, "")
	return nil
}

func (a api) FarmSay(ctx context.Context, body protocol.SayRequest) error {
	if body.Bed != nil {
		a.f.Site.WantBed(*body.Bed)
	}
	a.open()
	return refused(a.f.Foreman.Say(ctx, body.Text, str(body.Agent), body.Conversation))
}

func (a api) FarmOpenChannel(_ context.Context, body protocol.ChannelRequest) error {
	_, err := a.f.Chat.OpenChannel(body.Name, str(body.Description), str(body.Project))
	return refused(err)
}

func (a api) FarmAddSchedule(_ context.Context, body protocol.ScheduleRequest) (protocol.FarmSchedule, error) {
	s, err := a.f.Schedules.Add(body)
	return s, refused(err)
}

func (a api) FarmToggleSchedule(_ context.Context, id string, body protocol.ToggleScheduleRequest) error {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return protocol.FarmRefused{Reason: "没有这个定时：" + id}
	}
	_, err = a.f.Schedules.SetEnabled(n, body.Enabled)
	return refused(err)
}

func (a api) FarmRemoveSchedule(_ context.Context, id string) error {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return protocol.FarmRefused{Reason: "没有这个定时：" + id}
	}
	_, err = a.f.Schedules.Remove(n)
	return refused(err)
}

func (a api) FarmUpdateChannel(_ context.Context, id string, body protocol.ChannelUpdate) error {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return protocol.FarmRefused{Reason: "没有这个频道：" + id}
	}
	return refused(a.f.Chat.UpdateChannel(n, body.Description, body.Project))
}

func (a api) FarmDispatch(_ context.Context, body protocol.SayRequest) error {
	a.open()
	a.f.Foreman.Heard(body.Text, str(body.Agent))
	return nil
}

// FarmTell: watering, 杀虫, resolving a conflict: said in the helper's job thread, which wakes it.
func (a api) FarmTell(_ context.Context, id string, body protocol.TellRequest) error {
	if err := a.worker(id); err != nil {
		return err
	}
	text := body.Text
	if body.On != nil {
		steps, _ := a.f.Crew.Steps(id)
		i := slices.IndexFunc(steps, func(s protocol.WorkStep) bool { return s.N == *body.On })
		if i < 0 {
			return protocol.FarmMissing{What: fmt.Sprintf("第 %d 步（太早的步骤不再保留）", *body.On)}
		}
		text = runs.CommentText(steps[i], body.Text)
	}
	_, _ = a.f.Chat.TellHelper("user", id, text)
	return nil
}

func (a api) FarmStop(_ context.Context, id string) error {
	if err := a.worker(id); err != nil {
		return err
	}
	a.f.Crew.Stop(id)
	return nil
}

func (a api) FarmDismiss(_ context.Context, id string) error {
	if err := a.worker(id); err != nil {
		return err
	}
	a.f.Crew.Dismiss(id)
	return nil
}

func (a api) FarmHarvest(_ context.Context, id string) error {
	if err := a.worker(id); err != nil {
		return err
	}
	a.f.Merges.Harvest(id)
	return nil
}

// FarmChanges: the person looking over a harvest before saying yes, on the ledger (验收).
func (a api) FarmChanges(_ context.Context, id string) (protocol.Changes, error) {
	changes, err := a.f.Merges.Changes(id)
	if err != nil {
		return protocol.Changes{}, refused(err)
	}
	if changes == nil {
		return protocol.Changes{}, missing("帮工 " + id)
	}
	a.f.Ledger.Record(protocol.LedgerEntryReviewed{Helper: id})
	return *changes, nil
}

func (a api) FarmSteps(_ context.Context, id string) ([]protocol.WorkStep, error) {
	steps, ok := a.f.Crew.Steps(id)
	if !ok {
		return nil, missing("帮工 " + id)
	}
	return steps, nil
}

func (a api) FarmTrajectories(_ context.Context, agent *string) ([]protocol.TrajectoryHead, error) {
	return a.f.Trajectories.List(str(agent)), nil
}

func (a api) FarmTrajectory(_ context.Context, id string) (protocol.Trajectory, error) {
	if t := a.f.Trajectories.Get(id); t != nil {
		return *t, nil
	}
	return protocol.Trajectory{}, missing("轨迹 " + id)
}

func (a api) FarmPlan(_ context.Context, body protocol.PlanRequest) (string, error) {
	s, err := a.f.Playbooks.Plan(body.Goal, body.Project, str(body.Agent), protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) FarmEditNode(_ context.Context, id, node string, body protocol.NodeEdit) (string, error) {
	s, err := a.f.Playbooks.EditNode(id, node, body, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) FarmRemoveNode(_ context.Context, id, node string) (string, error) {
	s, err := a.f.Playbooks.RemoveNode(id, node, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) FarmPlaybookAct(_ context.Context, id string, body protocol.PlaybookActRequest) (string, error) {
	s, err := a.f.Playbooks.Act(id, body.Action, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) FarmNodeAct(_ context.Context, id, node string, body protocol.NodeActRequest) (string, error) {
	s, err := a.f.Playbooks.NodeAct(id, node, body.Action, protocol.PlaybookActorUser)
	return s, refused(err)
}

func (a api) FarmChatHistory(_ context.Context, id string, before, limit *string) ([]protocol.ChatMessage, error) {
	n, err := number(id)
	if err != nil {
		return nil, err
	}
	messages, err := a.f.Chat.History(n, optNumber(before), optNumber(limit))
	if err != nil {
		return nil, missing(err.Error())
	}
	return messages, nil
}

func (a api) FarmChatRead(_ context.Context, id string, body protocol.ChatReadRequest) error {
	n, err := number(id)
	if err != nil {
		return err
	}
	if err := a.f.Chat.MarkRead(n, body.Seq); err != nil {
		return missing(err.Error())
	}
	return nil
}

func (a api) FarmPlaybookChanges(_ context.Context, id string) (protocol.Changes, error) {
	c, err := a.f.Playbooks.Changes(id)
	return c, refused(err)
}

func (a api) FarmPlaybookEvents(_ context.Context, id string) ([]protocol.PlaybookEvent, error) {
	return a.f.Playbooks.Events(id), nil
}

func (a api) FarmCarryCoins(_ context.Context, body protocol.CarryCoinsRequest) (protocol.CarryCoinsResult, error) {
	return protocol.CarryCoinsResult{Carried: a.f.Ledger.Carry(body.Coins)}, nil
}

func (a api) FarmChooseTitle(_ context.Context, body protocol.ChooseTitleRequest) error {
	entry := protocol.LedgerEntryTitled{}
	if body.Achievement != nil && *body.Achievement != "" {
		entry.Achievement = body.Achievement
	}
	if body.Tier != nil && *body.Tier != 0 {
		entry.Tier = body.Tier
	}
	a.f.Ledger.Record(entry)
	return nil
}

func (a api) FarmRuntimes(ctx context.Context) ([]protocol.RuntimeInfo, error) {
	return a.f.Runtimes.List(ctx), nil
}

func (a api) FarmRefreshRuntime(ctx context.Context, id string) (protocol.RuntimeInfo, error) {
	if info := a.f.Runtimes.Refresh(ctx, id); info != nil {
		return *info, nil
	}
	return protocol.RuntimeInfo{}, missing("runtime " + id)
}

func (a api) FarmUpdateRuntime(ctx context.Context, id string, body protocol.RuntimeSettings) (protocol.RuntimeInfo, error) {
	if info := a.f.Runtimes.Update(ctx, id, body); info != nil {
		return *info, nil
	}
	return protocol.RuntimeInfo{}, missing("runtime " + id)
}

func (a api) FarmUpgradeRuntime(context.Context, string) (protocol.RuntimeInfo, error) {
	return protocol.RuntimeInfo{}, protocol.FarmRefused{Reason: "升级会改动这台机器：请在终端里用这个 runtime 自己的升级命令"}
}

func (a api) FarmAgents(context.Context) ([]protocol.AgentProfile, error) {
	return a.f.Store.Agents(), nil
}

func (a api) FarmSaveAgent(_ context.Context, _ string, body protocol.AgentProfile) (protocol.AgentProfile, error) {
	return a.f.Store.SaveAgent(body)
}

func (a api) FarmDeleteAgent(_ context.Context, id string) error { return a.f.Store.DeleteAgent(id) }

func (a api) FarmMemories(_ context.Context, id string) ([]protocol.Memory, error) {
	return a.f.Memories.List(id), nil
}

func (a api) FarmRemember(_ context.Context, id string, body protocol.MemoryRequest) (protocol.Memory, error) {
	m, err := a.f.Memories.Write(id, body.Text, str(body.Project))
	return m, refused(err)
}

func (a api) FarmForget(_ context.Context, id, memory string) error {
	_ = a.f.Memories.Forget(id, memory)
	return nil
}

func (a api) FarmManagerMemory(context.Context) (protocol.ManagerMemory, error) {
	return a.f.ManagerMemory.View(), nil
}

func (a api) FarmManagerRemember(_ context.Context, body protocol.MemoryRequest) (protocol.Memory, error) {
	m, err := a.f.ManagerMemory.Write(body.Text)
	return m, refused(err)
}

func (a api) FarmManagerForget(_ context.Context, memory string) error {
	_ = a.f.ManagerMemory.Forget(memory)
	return nil
}

func (a api) FarmManagerArchive(_ context.Context, q *string) (protocol.ArchiveListing, error) {
	return a.f.ManagerMemory.Archive(str(q)), nil
}

func (a api) FarmManagerArchiveFile(_ context.Context, name string) (string, error) {
	if text, ok := a.f.ManagerMemory.ArchiveFile(name); ok {
		return text, nil
	}
	return "", missing("旧账 " + name)
}

func (a api) FarmSkills(context.Context) ([]protocol.Skill, error) { return a.f.Store.Skills(), nil }

func (a api) FarmSaveSkill(_ context.Context, _ string, body protocol.Skill) (protocol.Skill, error) {
	return a.f.Store.SaveSkill(body)
}

func (a api) FarmDeleteSkill(_ context.Context, id string) error { return a.f.Store.DeleteSkill(id) }

func (a api) FarmProjects(ctx context.Context) ([]protocol.ProjectSummary, error) {
	return a.f.Codebase.List(ctx), nil
}

func (a api) FarmCreateProject(_ context.Context, body protocol.NewProject) (protocol.ProjectSummary, error) {
	p, err := a.f.Projects.Create(body)
	if err != nil {
		return protocol.ProjectSummary{}, refused(err)
	}
	return a.f.Codebase.Summary(p), nil
}

func (a api) FarmProjectLanguages(ctx context.Context, id string) (protocol.ProjectLanguages, error) {
	langs, err := a.f.Codebase.Languages(ctx, id)
	if err != nil {
		return protocol.ProjectLanguages{}, refused(err)
	}
	if langs == nil {
		return protocol.ProjectLanguages{}, missing("项目 " + id)
	}
	return *langs, nil
}

func (a api) FarmProjectActivity(ctx context.Context, id string) (protocol.ProjectActivity, error) {
	if act := a.f.Codebase.Activity(ctx, id); act != nil {
		return *act, nil
	}
	return protocol.ProjectActivity{}, missing("项目 " + id)
}

// The voice endpoints log each step of a call and why one failed (never a token or a key): a call that goes wrong is
// read back from the server's log.

func (a api) VoiceSession(ctx context.Context) (protocol.VoiceSession, error) {
	s, err := a.f.Voice.Session(ctx)
	voiceLog("session", s.Channel, err)
	return s, err
}

func (a api) VoiceRenew(ctx context.Context, body protocol.RenewRequest) (protocol.VoiceSession, error) {
	s, err := a.f.Voice.Renew(ctx, body.Channel, body.UID)
	voiceLog("renew", body.Channel, err)
	return s, err
}

func (a api) VoiceStart(ctx context.Context, body protocol.StartRequest) (protocol.VoiceAgent, error) {
	captions := "rtm"
	if body.Captions != nil {
		captions = string(*body.Captions)
	}
	started := time.Now()
	agent, err := a.f.Voice.Start(ctx, body.Channel, body.UID, body.Captions)
	voiceLog(fmt.Sprintf("agent start (captions %s, %d ms) %s", captions, time.Since(started).Milliseconds(), agent.AgentID), body.Channel, err)
	if err == nil {
		a.f.Ledger.Record(protocol.LedgerEntryOpenedPlannedVoiceBusy6{Kind: protocol.LedgerEntryOpenedPlannedVoiceBusy6KindVoice})
	}
	return agent, err
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

func (a api) ConnectorsList(context.Context) ([]protocol.ConnectorStatus, error) {
	return a.f.Connectors.List(), nil
}

func (a api) ConnectorsLogin(_ context.Context, id protocol.ConnectorID, body protocol.ConnectorLogin) (protocol.ConnectorStatus, error) {
	return a.f.Connectors.Login(id, body), nil
}

func (a api) ConnectorsVerify(_ context.Context, id protocol.ConnectorID, body protocol.VerifyRequest) (protocol.ConnectorStatus, error) {
	return a.f.Connectors.Verify(id, body.Code), nil
}

func (a api) ConnectorsLogout(_ context.Context, id protocol.ConnectorID) (protocol.ConnectorStatus, error) {
	return a.f.Connectors.Logout(id), nil
}

func (a api) ConnectorsChannel(_ context.Context, id protocol.ConnectorID, body protocol.ConnectorsChannelRequest) (protocol.ConnectorStatus, error) {
	s, err := a.f.Connectors.SetChannel(id, body.Channel)
	if err != nil {
		return s, protocol.ConnectorRefused{Reason: err.Error()}
	}
	return s, nil
}

func (a api) LanStatus(context.Context) (protocol.LanStatus, error) { return a.f.Lan.Status(), nil }

func (a api) LanSetOpen(_ context.Context, body protocol.SetOpenRequest) (protocol.LanStatus, error) {
	return a.f.Lan.SetOpen(body.Open)
}

func (a api) LanStartPairing(context.Context) (protocol.LanStatus, error) {
	return a.f.Lan.StartPairing()
}

func (a api) LanStopPairing(context.Context) (protocol.LanStatus, error) {
	return a.f.Lan.StopPairing(), nil
}

func (a api) LanAnswerPairing(_ context.Context, body protocol.AnswerPairingRequest) (protocol.LanStatus, error) {
	return a.f.Lan.Answer(body.Allow)
}

func (a api) LanForgetDevice(_ context.Context, id string) (protocol.LanStatus, error) {
	return a.f.Lan.Forget(id)
}

func (a api) LanPair(ctx context.Context, body protocol.LanPairRequest) (protocol.LanPaired, error) {
	return a.f.Lan.Pair(ctx, body.Code, body.Name)
}

func (a api) LanMe(ctx context.Context) (protocol.LanDevice, error) { return a.f.Lan.Me(ctx) }

func (a api) FarmReopen(ctx context.Context, id string, body protocol.ReopenRequest) (protocol.Dispatched, error) {
	helper, err := a.f.Dispatch.Reopen(context.WithoutCancel(ctx), id, body.Text, a.f.Chat.Square())
	if err != nil {
		return protocol.Dispatched{}, refused(err)
	}
	return protocol.Dispatched{Helper: &helper}, nil
}

func (a api) FarmIssues(context.Context) ([]protocol.Issue, error) { return a.f.Issues.List() }

func (a api) FarmIssue(_ context.Context, id string) (protocol.Issue, error) {
	return a.f.Issues.Get(id)
}

func (a api) FarmAddIssue(_ context.Context, body protocol.IssueRequest) (protocol.Issue, error) {
	return a.f.Issues.Add(body)
}

func (a api) FarmEditIssue(_ context.Context, id string, body protocol.IssueRequest) (protocol.Issue, error) {
	return a.f.Issues.Edit(id, body)
}

func (a api) FarmMoveIssue(_ context.Context, id string, body protocol.MoveIssueRequest) ([]protocol.Issue, error) {
	return a.f.Issues.Move(id, str(body.Before))
}

func (a api) FarmRemoveIssue(_ context.Context, id string) error { return a.f.Issues.Remove(id) }

func (a api) FarmStartIssue(ctx context.Context, id string) (protocol.Dispatched, error) {
	got, err := a.f.Dispatch.Start(context.WithoutCancel(ctx), id, a.f.Chat.Square())
	return got, refused(err)
}

func (a api) FarmQueueIssue(_ context.Context, id string, body protocol.QueueIssueRequest) (protocol.Issue, error) {
	return a.f.Issues.Queue(id, body.Queued)
}
