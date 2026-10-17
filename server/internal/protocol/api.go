package protocol

import "context"

// One method each, so a new endpoint fails the build until it is answered. vibevalley:route is the operation (group.name, the Flutter client's
// api.group.name), method and path; vibevalley:can is who may call it: owner (on the farm's machine), remote (a device through the
// gate, which lets only these through), manager (its tools), session (a worker, with its key). The table is Endpoints in gen.go and
// docs/reference/capabilities.md.
type Handlers interface {
	//vibevalley:route server.health GET /api/health
	//vibevalley:can owner remote
	ServerHealth(ctx context.Context) (Health, error)
	//vibevalley:route manager.open POST /api/manager/open
	//vibevalley:can owner remote
	ManagerOpen(ctx context.Context) error
	//vibevalley:route setting.load GET /api/settings
	//vibevalley:can owner remote
	SettingLoad(ctx context.Context) (SettingsStatus, error)
	// The first thing Save would refuse in these settings, without saving them.
	//vibevalley:route setting.check POST /api/settings/check
	//vibevalley:can owner remote
	SettingCheck(ctx context.Context, body SettingsUpdate) (SettingsCheck, error)
	//vibevalley:route setting.save PUT /api/settings
	//vibevalley:can owner remote
	SettingSave(ctx context.Context, body SettingsUpdate) (SettingsStatus, error)
	//vibevalley:route channel.say POST /api/say
	//vibevalley:can owner remote
	ChannelSay(ctx context.Context, body SayRequest) error
	//vibevalley:route channel.create POST /api/channels
	//vibevalley:can owner remote manager
	ChannelCreate(ctx context.Context, body ChannelRequest) error
	//vibevalley:route schedule.create POST /api/schedules
	//vibevalley:can owner remote manager
	ScheduleCreate(ctx context.Context, body ScheduleRequest) (Schedule, error)
	//vibevalley:route schedule.list GET /api/schedules
	//vibevalley:can owner remote manager
	ScheduleList(ctx context.Context) ([]Schedule, error)
	// Only what the body gives changes.
	//vibevalley:route schedule.update PUT /api/schedules/{id}
	//vibevalley:can owner remote
	ScheduleUpdate(ctx context.Context, pID int64, body ScheduleUpdate) error
	//vibevalley:route schedule.delete DELETE /api/schedules/{id}
	//vibevalley:can owner remote manager
	ScheduleDelete(ctx context.Context, pID int64) error
	//vibevalley:route channel.update PUT /api/channels/{id}
	//vibevalley:can owner remote manager
	ChannelUpdate(ctx context.Context, pID int64, body ChannelUpdate) error
	//vibevalley:route manager.hear POST /api/manager/hear
	//vibevalley:can owner remote
	ManagerHear(ctx context.Context, body SayRequest) error
	//vibevalley:route worker.tell POST /api/workers/{id}/tell
	//vibevalley:can owner remote manager
	WorkerTell(ctx context.Context, pID string, body TellRequest) error
	//vibevalley:route worker.stop POST /api/workers/{id}/stop
	//vibevalley:can owner remote manager
	WorkerStop(ctx context.Context, pID string) error
	//vibevalley:route worker.dismiss POST /api/workers/{id}/dismiss
	//vibevalley:can owner remote manager
	WorkerDismiss(ctx context.Context, pID string) error
	//vibevalley:route worker.merge POST /api/workers/{id}/merge
	//vibevalley:can owner remote manager
	WorkerMerge(ctx context.Context, pID string) error
	// Tells the worker to merge its base in and settle the conflicts, in the owner's words (ConflictTask).
	//vibevalley:route worker.resolve POST /api/workers/{id}/resolve
	//vibevalley:can owner remote
	WorkerResolve(ctx context.Context, pID string) error
	//vibevalley:route worker.changes GET /api/workers/{id}/changes
	//vibevalley:can owner remote manager
	WorkerChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route trajectory.list GET /api/trajectories
	//vibevalley:can owner remote
	TrajectoryList(ctx context.Context, pAgent *string) ([]TrajectoryHead, error)
	//vibevalley:route trajectory.get GET /api/trajectories/{id}
	//vibevalley:can owner remote
	TrajectoryGet(ctx context.Context, pID string) (Trajectory, error)
	//vibevalley:route issue.list GET /api/issues
	//vibevalley:can owner remote
	IssueList(ctx context.Context) ([]Issue, error)
	//vibevalley:route issue.get GET /api/issues/{id}
	//vibevalley:can owner remote
	IssueGet(ctx context.Context, pID string) (Issue, error)
	//vibevalley:route issue.runs GET /api/issues/{id}/runs
	//vibevalley:can owner remote
	IssueRuns(ctx context.Context, pID string) ([]Run, error)
	//vibevalley:route issue.create POST /api/issues
	//vibevalley:can owner remote
	IssueCreate(ctx context.Context, body IssueRequest) (Issue, error)
	//vibevalley:route issue.update PUT /api/issues/{id}
	//vibevalley:can owner remote
	IssueUpdate(ctx context.Context, pID string, body IssueRequest) (Issue, error)
	//vibevalley:route issue.delete DELETE /api/issues/{id}
	//vibevalley:can owner remote
	IssueDelete(ctx context.Context, pID string) error
	//vibevalley:route issue.move PUT /api/issues/{id}/move
	//vibevalley:can owner remote
	IssueMove(ctx context.Context, pID string, body MoveIssueRequest) ([]Issue, error)
	// Back to the backlog; an issue is queued by issue.start when there is no room.
	//vibevalley:route issue.unqueue POST /api/issues/{id}/unqueue
	//vibevalley:can owner remote
	IssueUnqueue(ctx context.Context, pID string) (Issue, error)
	//vibevalley:route issue.start POST /api/issues/{id}/start
	//vibevalley:can owner remote manager
	IssueStart(ctx context.Context, pID string) (Dispatched, error)
	//vibevalley:route issue.reopen POST /api/issues/{id}/reopen
	//vibevalley:can owner remote
	IssueReopen(ctx context.Context, pID string, body ReopenRequest) (Dispatched, error)
	//vibevalley:route playbook.plan POST /api/playbooks
	//vibevalley:can owner remote manager
	PlaybookPlan(ctx context.Context, body PlanRequest) (string, error)
	//vibevalley:route playbook.updateNode PUT /api/playbooks/{id}/nodes/{node}
	//vibevalley:can owner remote manager
	PlaybookUpdateNode(ctx context.Context, pID string, pNode string, body NodeEdit) (string, error)
	//vibevalley:route playbook.deleteNode DELETE /api/playbooks/{id}/nodes/{node}
	//vibevalley:can owner remote manager
	PlaybookDeleteNode(ctx context.Context, pID string, pNode string) (string, error)
	//vibevalley:route playbook.act POST /api/playbooks/{id}/act
	//vibevalley:can owner remote manager
	PlaybookAct(ctx context.Context, pID string, body PlaybookActRequest) (string, error)
	//vibevalley:route playbook.nodeAct POST /api/playbooks/{id}/nodes/{node}/act
	//vibevalley:can owner remote manager
	PlaybookNodeAct(ctx context.Context, pID string, pNode string, body NodeActRequest) (string, error)
	//vibevalley:route channel.history GET /api/channels/{id}/messages
	//vibevalley:can owner remote manager
	ChannelHistory(ctx context.Context, pID int64, pBefore *int64, pLimit *int64) ([]ChatMessage, error)
	//vibevalley:route channel.markRead POST /api/channels/{id}/read
	//vibevalley:can owner remote
	ChannelMarkRead(ctx context.Context, pID int64, body ChatReadRequest) error
	//vibevalley:route playbook.changes GET /api/playbooks/{id}/changes
	//vibevalley:can owner remote
	PlaybookChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route playbook.events GET /api/playbooks/{id}/events
	//vibevalley:can owner remote
	PlaybookEvents(ctx context.Context, pID string) ([]PlaybookEvent, error)
	//vibevalley:route game.chooseTitle POST /api/game/title
	//vibevalley:can owner remote
	GameChooseTitle(ctx context.Context, body ChooseTitleRequest) error
	//vibevalley:route runtime.list GET /api/runtimes
	//vibevalley:can owner remote
	RuntimeList(ctx context.Context) ([]RuntimeInfo, error)
	//vibevalley:route runtime.refresh POST /api/runtimes/{id}/refresh
	//vibevalley:can owner remote
	RuntimeRefresh(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route runtime.update PUT /api/runtimes/{id}/settings
	//vibevalley:can owner remote
	RuntimeUpdate(ctx context.Context, pID string, body RuntimeSettings) (RuntimeInfo, error)
	//vibevalley:route runtime.upgrade POST /api/runtimes/{id}/upgrade
	//vibevalley:can owner remote
	RuntimeUpgrade(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route agent.list GET /api/agents
	//vibevalley:can owner remote
	AgentList(ctx context.Context) ([]Agent, error)
	// The issues of each profile as it would be dispatched now; a draft not saved yet too.
	//vibevalley:route agent.check POST /api/agents/check
	//vibevalley:can owner remote
	AgentCheck(ctx context.Context, body AgentCheckRequest) ([]AgentCheck, error)
	//vibevalley:route agent.save PUT /api/agents/{id}
	//vibevalley:can owner remote
	AgentSave(ctx context.Context, pID string, body Agent) (Agent, error)
	//vibevalley:route agent.delete DELETE /api/agents/{id}
	//vibevalley:can owner remote
	AgentDelete(ctx context.Context, pID string) error
	//vibevalley:route agent.memories GET /api/agents/{id}/memories
	//vibevalley:can owner remote
	AgentMemories(ctx context.Context, pID string) ([]Memory, error)
	//vibevalley:route agent.recall GET /api/agents/{id}/recall
	//vibevalley:can owner remote
	AgentRecall(ctx context.Context, pID string, pProject *string, pText *string) (RecallPreview, error)
	//vibevalley:route agent.remember POST /api/agents/{id}/memories
	//vibevalley:can owner remote
	AgentRemember(ctx context.Context, pID string, body MemoryRequest) (Memory, error)
	//vibevalley:route agent.forget DELETE /api/agents/{id}/memories/{memory}
	//vibevalley:can owner remote
	AgentForget(ctx context.Context, pID string, pMemory string) error
	//vibevalley:route manager.memories GET /api/manager/memories
	//vibevalley:can owner remote
	ManagerMemories(ctx context.Context) (ManagerMemory, error)
	//vibevalley:route manager.remember POST /api/manager/memories
	//vibevalley:can owner remote manager
	ManagerRemember(ctx context.Context, body MemoryRequest) (Memory, error)
	//vibevalley:route manager.forget DELETE /api/manager/memories/{memory}
	//vibevalley:can owner remote
	ManagerForget(ctx context.Context, pMemory string) error
	//vibevalley:route manager.listArchive GET /api/manager/archive
	//vibevalley:can owner remote manager
	ManagerListArchive(ctx context.Context, pQ *string) (ArchiveListing, error)
	//vibevalley:route manager.getArchive GET /api/manager/archive/{name}
	//vibevalley:can owner remote
	ManagerGetArchive(ctx context.Context, pName string) (string, error)
	//vibevalley:route skill.list GET /api/skills
	//vibevalley:can owner remote
	SkillList(ctx context.Context) ([]Skill, error)
	//vibevalley:route skill.save PUT /api/skills/{id}
	//vibevalley:can owner remote
	SkillSave(ctx context.Context, pID string, body Skill) (Skill, error)
	//vibevalley:route skill.delete DELETE /api/skills/{id}
	//vibevalley:can owner remote
	SkillDelete(ctx context.Context, pID string) error
	//vibevalley:route project.list GET /api/projects
	//vibevalley:can owner remote manager
	ProjectList(ctx context.Context) ([]ProjectSummary, error)
	// The first thing Create would refuse in this project, without making it.
	//vibevalley:route project.check POST /api/projects/check
	//vibevalley:can owner remote
	ProjectCheck(ctx context.Context, body NewProject) (ProjectCheck, error)
	//vibevalley:route project.create POST /api/projects
	//vibevalley:can owner remote
	ProjectCreate(ctx context.Context, body NewProject) (ProjectSummary, error)
	//vibevalley:route project.languages GET /api/projects/{id}/languages
	//vibevalley:can owner remote
	ProjectLanguages(ctx context.Context, pID string) (ProjectLanguages, error)
	//vibevalley:route project.activity GET /api/projects/{id}/activity
	//vibevalley:can owner remote
	ProjectActivity(ctx context.Context, pID string) (ProjectActivity, error)
	//vibevalley:route voice.session POST /api/voice/session
	//vibevalley:can owner remote
	VoiceSession(ctx context.Context) (VoiceSession, error)
	//vibevalley:route voice.renew POST /api/voice/renew
	//vibevalley:can owner remote
	VoiceRenew(ctx context.Context, body RenewRequest) (VoiceSession, error)
	//vibevalley:route voice.start POST /api/voice/agent
	//vibevalley:can owner remote
	VoiceStart(ctx context.Context, body StartRequest) (VoiceAgent, error)
	//vibevalley:route voice.stop POST /api/voice/agent/stop
	//vibevalley:can owner remote
	VoiceStop(ctx context.Context, body VoiceAgent) error
	//vibevalley:route connector.list GET /api/connectors
	//vibevalley:can owner remote
	ConnectorList(ctx context.Context) ([]ConnectorStatus, error)
	//vibevalley:route connector.login POST /api/connectors/{id}/login
	//vibevalley:can owner remote
	ConnectorLogin(ctx context.Context, pID ConnectorID, body ConnectorLogin) (ConnectorStatus, error)
	//vibevalley:route connector.verify POST /api/connectors/{id}/verify
	//vibevalley:can owner remote
	ConnectorVerify(ctx context.Context, pID ConnectorID, body VerifyRequest) (ConnectorStatus, error)
	//vibevalley:route connector.logout POST /api/connectors/{id}/logout
	//vibevalley:can owner remote
	ConnectorLogout(ctx context.Context, pID ConnectorID) (ConnectorStatus, error)
	//vibevalley:route connector.channel PUT /api/connectors/{id}/channel
	//vibevalley:can owner remote
	ConnectorChannel(ctx context.Context, pID ConnectorID, body ConnectorsChannelRequest) (ConnectorStatus, error)
	//vibevalley:route gate.status GET /api/gate
	//vibevalley:can owner
	GateStatus(ctx context.Context) (LanStatus, error)
	//vibevalley:route gate.update PUT /api/gate
	//vibevalley:can owner
	GateUpdate(ctx context.Context, body SetOpenRequest) (LanStatus, error)
	//vibevalley:route gate.startPairing POST /api/gate/pairing
	//vibevalley:can owner
	GateStartPairing(ctx context.Context) (LanStatus, error)
	//vibevalley:route gate.stopPairing DELETE /api/gate/pairing
	//vibevalley:can owner
	GateStopPairing(ctx context.Context) (LanStatus, error)
	//vibevalley:route gate.answerPairing POST /api/gate/pairing/answer
	//vibevalley:can owner
	GateAnswerPairing(ctx context.Context, body AnswerPairingRequest) (LanStatus, error)
	//vibevalley:route gate.deleteDevice DELETE /api/gate/devices/{id}
	//vibevalley:can owner
	GateDeleteDevice(ctx context.Context, pID string) (LanStatus, error)
	//vibevalley:route gate.pair POST /api/gate/pair
	//vibevalley:can owner remote
	GatePair(ctx context.Context, body LanPairRequest) (LanPaired, error)
	//vibevalley:route gate.me GET /api/gate/me
	//vibevalley:can owner remote
	GateMe(ctx context.Context) (LanDevice, error)
}
