package protocol

import "context"

// One method each, so a new endpoint fails the build until it is answered. vibevalley:route is the operation (group.name, the Flutter client's
// api.group.name), method and path.
type Handlers interface {
	//vibevalley:route server.health GET /api/health
	ServerHealth(ctx context.Context) (Health, error)
	//vibevalley:route server.start POST /api/start
	ServerStart(ctx context.Context) error
	//vibevalley:route setting.load GET /api/settings
	SettingLoad(ctx context.Context) (SettingsStatus, error)
	// The first thing Save would refuse in these settings, without saving them.
	//vibevalley:route setting.check POST /api/settings/check
	SettingCheck(ctx context.Context, body SettingsUpdate) (SettingsCheck, error)
	//vibevalley:route setting.save PUT /api/settings
	SettingSave(ctx context.Context, body SettingsUpdate) (SettingsStatus, error)
	//vibevalley:route server.end POST /api/end
	ServerEnd(ctx context.Context) error
	//vibevalley:route channel.say POST /api/say
	ChannelSay(ctx context.Context, body SayRequest) error
	//vibevalley:route channel.open POST /api/channels
	ChannelOpen(ctx context.Context, body ChannelRequest) error
	//vibevalley:route schedule.add POST /api/schedules
	ScheduleAdd(ctx context.Context, body ScheduleRequest) (Schedule, error)
	//vibevalley:route schedule.toggle PUT /api/schedules/{id}
	ScheduleToggle(ctx context.Context, pID int64, body ToggleScheduleRequest) error
	//vibevalley:route schedule.remove DELETE /api/schedules/{id}
	ScheduleRemove(ctx context.Context, pID int64) error
	//vibevalley:route channel.update PUT /api/channels/{id}
	ChannelUpdate(ctx context.Context, pID int64, body ChannelUpdate) error
	//vibevalley:route issue.dispatch POST /api/dispatch
	IssueDispatch(ctx context.Context, body SayRequest) error
	//vibevalley:route worker.tell POST /api/workers/{id}/tell
	WorkerTell(ctx context.Context, pID string, body TellRequest) error
	//vibevalley:route worker.stop POST /api/workers/{id}/stop
	WorkerStop(ctx context.Context, pID string) error
	//vibevalley:route worker.dismiss POST /api/workers/{id}/dismiss
	WorkerDismiss(ctx context.Context, pID string) error
	//vibevalley:route worker.merge POST /api/workers/{id}/merge
	WorkerMerge(ctx context.Context, pID string) error
	// Tells the worker to merge its base in and settle the conflicts, in the owner's words (ConflictTask).
	//vibevalley:route worker.resolve POST /api/workers/{id}/resolve
	WorkerResolve(ctx context.Context, pID string) error
	//vibevalley:route worker.changes GET /api/workers/{id}/changes
	WorkerChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route worker.activities GET /api/workers/{id}/activities
	WorkerActivities(ctx context.Context, pID string) ([]Activity, error)
	//vibevalley:route trajectory.list GET /api/trajectories
	TrajectoryList(ctx context.Context, pAgent *string) ([]TrajectoryHead, error)
	//vibevalley:route trajectory.find GET /api/trajectories/{id}
	TrajectoryFind(ctx context.Context, pID string) (Trajectory, error)
	//vibevalley:route issue.list GET /api/issues
	IssueList(ctx context.Context) ([]Issue, error)
	//vibevalley:route issue.find GET /api/issues/{id}
	IssueFind(ctx context.Context, pID string) (Issue, error)
	//vibevalley:route issue.runs GET /api/issues/{id}/runs
	IssueRuns(ctx context.Context, pID string) ([]Run, error)
	//vibevalley:route issue.add POST /api/issues
	IssueAdd(ctx context.Context, body IssueRequest) (Issue, error)
	//vibevalley:route issue.edit PUT /api/issues/{id}
	IssueEdit(ctx context.Context, pID string, body IssueRequest) (Issue, error)
	//vibevalley:route issue.remove DELETE /api/issues/{id}
	IssueRemove(ctx context.Context, pID string) error
	//vibevalley:route issue.move PUT /api/issues/{id}/place
	IssueMove(ctx context.Context, pID string, body MoveIssueRequest) ([]Issue, error)
	//vibevalley:route issue.queue PUT /api/issues/{id}/queue
	IssueQueue(ctx context.Context, pID string, body QueueIssueRequest) (Issue, error)
	//vibevalley:route issue.start POST /api/issues/{id}/start
	IssueStart(ctx context.Context, pID string) (Dispatched, error)
	//vibevalley:route issue.reopen POST /api/issues/{id}/reopen
	IssueReopen(ctx context.Context, pID string, body ReopenRequest) (Dispatched, error)
	//vibevalley:route playbook.plan POST /api/playbooks
	PlaybookPlan(ctx context.Context, body PlanRequest) (string, error)
	//vibevalley:route playbook.editNode PUT /api/playbooks/{id}/nodes/{node}
	PlaybookEditNode(ctx context.Context, pID string, pNode string, body NodeEdit) (string, error)
	//vibevalley:route playbook.removeNode DELETE /api/playbooks/{id}/nodes/{node}
	PlaybookRemoveNode(ctx context.Context, pID string, pNode string) (string, error)
	//vibevalley:route playbook.act POST /api/playbooks/{id}/act
	PlaybookAct(ctx context.Context, pID string, body PlaybookActRequest) (string, error)
	//vibevalley:route playbook.nodeAct POST /api/playbooks/{id}/nodes/{node}/act
	PlaybookNodeAct(ctx context.Context, pID string, pNode string, body NodeActRequest) (string, error)
	//vibevalley:route channel.history GET /api/chat/{id}/messages
	ChannelHistory(ctx context.Context, pID int64, pBefore *int64, pLimit *int64) ([]ChatMessage, error)
	//vibevalley:route channel.read POST /api/chat/{id}/read
	ChannelRead(ctx context.Context, pID int64, body ChatReadRequest) error
	//vibevalley:route playbook.changes GET /api/playbooks/{id}/changes
	PlaybookChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route playbook.events GET /api/playbooks/{id}/events
	PlaybookEvents(ctx context.Context, pID string) ([]PlaybookEvent, error)
	//vibevalley:route progress.carryCoins POST /api/progress/carry
	ProgressCarryCoins(ctx context.Context, body CarryCoinsRequest) (CarryCoinsResult, error)
	//vibevalley:route progress.chooseTitle POST /api/progress/title
	ProgressChooseTitle(ctx context.Context, body ChooseTitleRequest) error
	//vibevalley:route runtime.list GET /api/runtimes
	RuntimeList(ctx context.Context) ([]RuntimeInfo, error)
	//vibevalley:route runtime.refresh POST /api/runtimes/{id}/refresh
	RuntimeRefresh(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route runtime.update PUT /api/runtimes/{id}/settings
	RuntimeUpdate(ctx context.Context, pID string, body RuntimeSettings) (RuntimeInfo, error)
	//vibevalley:route runtime.upgrade POST /api/runtimes/{id}/upgrade
	RuntimeUpgrade(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route agent.list GET /api/agents
	AgentList(ctx context.Context) ([]Agent, error)
	// The issues of each profile as it would be dispatched now; a draft not saved yet too.
	//vibevalley:route agent.check POST /api/agents/check
	AgentCheck(ctx context.Context, body AgentCheckRequest) ([]AgentCheck, error)
	//vibevalley:route agent.save PUT /api/agents/{id}
	AgentSave(ctx context.Context, pID string, body Agent) (Agent, error)
	//vibevalley:route agent.delete DELETE /api/agents/{id}
	AgentDelete(ctx context.Context, pID string) error
	//vibevalley:route agent.memories GET /api/agents/{id}/memories
	AgentMemories(ctx context.Context, pID string) ([]Memory, error)
	//vibevalley:route agent.recall GET /api/agents/{id}/recall
	AgentRecall(ctx context.Context, pID string, pProject *string, pText *string) (RecallPreview, error)
	//vibevalley:route agent.remember POST /api/agents/{id}/memories
	AgentRemember(ctx context.Context, pID string, body MemoryRequest) (Memory, error)
	//vibevalley:route agent.forget DELETE /api/agents/{id}/memories/{memory}
	AgentForget(ctx context.Context, pID string, pMemory string) error
	//vibevalley:route manager.memories GET /api/manager/memories
	ManagerMemories(ctx context.Context) (ManagerMemory, error)
	//vibevalley:route manager.remember POST /api/manager/memories
	ManagerRemember(ctx context.Context, body MemoryRequest) (Memory, error)
	//vibevalley:route manager.forget DELETE /api/manager/memories/{memory}
	ManagerForget(ctx context.Context, pMemory string) error
	//vibevalley:route manager.archive GET /api/manager/archive
	ManagerArchive(ctx context.Context, pQ *string) (ArchiveListing, error)
	//vibevalley:route manager.archiveFile GET /api/manager/archive/{name}
	ManagerArchiveFile(ctx context.Context, pName string) (string, error)
	//vibevalley:route skill.list GET /api/skills
	SkillList(ctx context.Context) ([]Skill, error)
	//vibevalley:route skill.save PUT /api/skills/{id}
	SkillSave(ctx context.Context, pID string, body Skill) (Skill, error)
	//vibevalley:route skill.delete DELETE /api/skills/{id}
	SkillDelete(ctx context.Context, pID string) error
	//vibevalley:route project.list GET /api/projects
	ProjectList(ctx context.Context) ([]ProjectSummary, error)
	// The first thing Create would refuse in this project, without making it.
	//vibevalley:route project.check POST /api/projects/check
	ProjectCheck(ctx context.Context, body NewProject) (ProjectCheck, error)
	//vibevalley:route project.create POST /api/projects
	ProjectCreate(ctx context.Context, body NewProject) (ProjectSummary, error)
	//vibevalley:route project.languages GET /api/projects/{id}/languages
	ProjectLanguages(ctx context.Context, pID string) (ProjectLanguages, error)
	//vibevalley:route project.activity GET /api/projects/{id}/activity
	ProjectActivity(ctx context.Context, pID string) (ProjectActivity, error)
	//vibevalley:route voice.session POST /api/voice/session
	VoiceSession(ctx context.Context) (VoiceSession, error)
	//vibevalley:route voice.renew POST /api/voice/renew
	VoiceRenew(ctx context.Context, body RenewRequest) (VoiceSession, error)
	//vibevalley:route voice.start POST /api/voice/agent
	VoiceStart(ctx context.Context, body StartRequest) (VoiceAgent, error)
	//vibevalley:route voice.stop POST /api/voice/agent/stop
	VoiceStop(ctx context.Context, body VoiceAgent) error
	//vibevalley:route connector.list GET /api/connectors
	ConnectorList(ctx context.Context) ([]ConnectorStatus, error)
	//vibevalley:route connector.login POST /api/connectors/{id}/login
	ConnectorLogin(ctx context.Context, pID ConnectorID, body ConnectorLogin) (ConnectorStatus, error)
	//vibevalley:route connector.verify POST /api/connectors/{id}/verify
	ConnectorVerify(ctx context.Context, pID ConnectorID, body VerifyRequest) (ConnectorStatus, error)
	//vibevalley:route connector.logout POST /api/connectors/{id}/logout
	ConnectorLogout(ctx context.Context, pID ConnectorID) (ConnectorStatus, error)
	//vibevalley:route connector.channel PUT /api/connectors/{id}/channel
	ConnectorChannel(ctx context.Context, pID ConnectorID, body ConnectorsChannelRequest) (ConnectorStatus, error)
	//vibevalley:route lan.status GET /api/lan
	LanStatus(ctx context.Context) (LanStatus, error)
	//vibevalley:route lan.setOpen PUT /api/lan
	LanSetOpen(ctx context.Context, body SetOpenRequest) (LanStatus, error)
	//vibevalley:route lan.startPairing POST /api/lan/pairing
	LanStartPairing(ctx context.Context) (LanStatus, error)
	//vibevalley:route lan.stopPairing DELETE /api/lan/pairing
	LanStopPairing(ctx context.Context) (LanStatus, error)
	//vibevalley:route lan.answerPairing POST /api/lan/pairing/answer
	LanAnswerPairing(ctx context.Context, body AnswerPairingRequest) (LanStatus, error)
	//vibevalley:route lan.forgetDevice DELETE /api/lan/devices/{id}
	LanForgetDevice(ctx context.Context, pID string) (LanStatus, error)
	//vibevalley:route lan.pair POST /api/lan/pair
	LanPair(ctx context.Context, body LanPairRequest) (LanPaired, error)
	//vibevalley:route lan.me GET /api/lan/me
	LanMe(ctx context.Context) (LanDevice, error)
}
