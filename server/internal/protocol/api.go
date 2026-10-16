package protocol

import "context"

// One method each, so a new endpoint fails the build until it is answered. vibevalley:route is the operation (group.name, the Flutter client's
// api.group.name), method and path.
type Handlers interface {
	//vibevalley:route farm.health GET /api/health
	FarmHealth(ctx context.Context) (Health, error)
	//vibevalley:route farm.start POST /api/start
	FarmStart(ctx context.Context) error
	//vibevalley:route farm.settings GET /api/settings
	FarmSettings(ctx context.Context) (SettingsStatus, error)
	//vibevalley:route farm.saveSettings PUT /api/settings
	FarmSaveSettings(ctx context.Context, body SettingsUpdate) (SettingsStatus, error)
	//vibevalley:route farm.end POST /api/end
	FarmEnd(ctx context.Context) error
	//vibevalley:route farm.say POST /api/say
	FarmSay(ctx context.Context, body SayRequest) error
	//vibevalley:route farm.openChannel POST /api/channels
	FarmOpenChannel(ctx context.Context, body ChannelRequest) error
	//vibevalley:route farm.addSchedule POST /api/schedules
	FarmAddSchedule(ctx context.Context, body ScheduleRequest) (FarmSchedule, error)
	//vibevalley:route farm.toggleSchedule PUT /api/schedules/{id}
	FarmToggleSchedule(ctx context.Context, pID string, body ToggleScheduleRequest) error
	//vibevalley:route farm.removeSchedule DELETE /api/schedules/{id}
	FarmRemoveSchedule(ctx context.Context, pID string) error
	//vibevalley:route farm.updateChannel PUT /api/channels/{id}
	FarmUpdateChannel(ctx context.Context, pID string, body ChannelUpdate) error
	//vibevalley:route farm.dispatch POST /api/dispatch
	FarmDispatch(ctx context.Context, body SayRequest) error
	//vibevalley:route farm.tell POST /api/workers/{id}/tell
	FarmTell(ctx context.Context, pID string, body TellRequest) error
	//vibevalley:route farm.stop POST /api/workers/{id}/stop
	FarmStop(ctx context.Context, pID string) error
	//vibevalley:route farm.dismiss POST /api/workers/{id}/dismiss
	FarmDismiss(ctx context.Context, pID string) error
	//vibevalley:route farm.harvest POST /api/workers/{id}/harvest
	FarmHarvest(ctx context.Context, pID string) error
	//vibevalley:route farm.changes GET /api/workers/{id}/changes
	FarmChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route farm.steps GET /api/workers/{id}/steps
	FarmSteps(ctx context.Context, pID string) ([]WorkStep, error)
	//vibevalley:route farm.trajectories GET /api/trajectories
	FarmTrajectories(ctx context.Context, pAgent *string) ([]TrajectoryHead, error)
	//vibevalley:route farm.trajectory GET /api/trajectories/{id}
	FarmTrajectory(ctx context.Context, pID string) (Trajectory, error)
	//vibevalley:route farm.issues GET /api/issues
	FarmIssues(ctx context.Context) ([]Issue, error)
	//vibevalley:route farm.issue GET /api/issues/{id}
	FarmIssue(ctx context.Context, pID string) (Issue, error)
	//vibevalley:route farm.addIssue POST /api/issues
	FarmAddIssue(ctx context.Context, body IssueRequest) (Issue, error)
	//vibevalley:route farm.editIssue PUT /api/issues/{id}
	FarmEditIssue(ctx context.Context, pID string, body IssueRequest) (Issue, error)
	//vibevalley:route farm.removeIssue DELETE /api/issues/{id}
	FarmRemoveIssue(ctx context.Context, pID string) error
	//vibevalley:route farm.moveIssue PUT /api/issues/{id}/place
	FarmMoveIssue(ctx context.Context, pID string, body MoveIssueRequest) ([]Issue, error)
	//vibevalley:route farm.queueIssue PUT /api/issues/{id}/queue
	FarmQueueIssue(ctx context.Context, pID string, body QueueIssueRequest) (Issue, error)
	//vibevalley:route farm.startIssue POST /api/issues/{id}/start
	FarmStartIssue(ctx context.Context, pID string) (Dispatched, error)
	//vibevalley:route farm.reopen POST /api/issues/{id}/reopen
	FarmReopen(ctx context.Context, pID string, body ReopenRequest) (Dispatched, error)
	//vibevalley:route farm.plan POST /api/playbooks
	FarmPlan(ctx context.Context, body PlanRequest) (string, error)
	//vibevalley:route farm.editNode PUT /api/playbooks/{id}/nodes/{node}
	FarmEditNode(ctx context.Context, pID string, pNode string, body NodeEdit) (string, error)
	//vibevalley:route farm.removeNode DELETE /api/playbooks/{id}/nodes/{node}
	FarmRemoveNode(ctx context.Context, pID string, pNode string) (string, error)
	//vibevalley:route farm.playbookAct POST /api/playbooks/{id}/act
	FarmPlaybookAct(ctx context.Context, pID string, body PlaybookActRequest) (string, error)
	//vibevalley:route farm.nodeAct POST /api/playbooks/{id}/nodes/{node}/act
	FarmNodeAct(ctx context.Context, pID string, pNode string, body NodeActRequest) (string, error)
	//vibevalley:route farm.chatHistory GET /api/chat/{id}/messages
	FarmChatHistory(ctx context.Context, pID string, pBefore *string, pLimit *string) ([]ChatMessage, error)
	//vibevalley:route farm.chatRead POST /api/chat/{id}/read
	FarmChatRead(ctx context.Context, pID string, body ChatReadRequest) error
	//vibevalley:route farm.playbookChanges GET /api/playbooks/{id}/changes
	FarmPlaybookChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route farm.playbookEvents GET /api/playbooks/{id}/events
	FarmPlaybookEvents(ctx context.Context, pID string) ([]PlaybookEvent, error)
	//vibevalley:route farm.carryCoins POST /api/progress/carry
	FarmCarryCoins(ctx context.Context, body CarryCoinsRequest) (CarryCoinsResult, error)
	//vibevalley:route farm.chooseTitle POST /api/progress/title
	FarmChooseTitle(ctx context.Context, body ChooseTitleRequest) error
	//vibevalley:route farm.runtimes GET /api/runtimes
	FarmRuntimes(ctx context.Context) ([]RuntimeInfo, error)
	//vibevalley:route farm.refreshRuntime POST /api/runtimes/{id}/refresh
	FarmRefreshRuntime(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route farm.updateRuntime PUT /api/runtimes/{id}/settings
	FarmUpdateRuntime(ctx context.Context, pID string, body RuntimeSettings) (RuntimeInfo, error)
	//vibevalley:route farm.upgradeRuntime POST /api/runtimes/{id}/upgrade
	FarmUpgradeRuntime(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route farm.agents GET /api/agents
	FarmAgents(ctx context.Context) ([]AgentProfile, error)
	//vibevalley:route farm.saveAgent PUT /api/agents/{id}
	FarmSaveAgent(ctx context.Context, pID string, body AgentProfile) (AgentProfile, error)
	//vibevalley:route farm.deleteAgent DELETE /api/agents/{id}
	FarmDeleteAgent(ctx context.Context, pID string) error
	//vibevalley:route farm.memories GET /api/agents/{id}/memories
	FarmMemories(ctx context.Context, pID string) ([]Memory, error)
	//vibevalley:route farm.remember POST /api/agents/{id}/memories
	FarmRemember(ctx context.Context, pID string, body MemoryRequest) (Memory, error)
	//vibevalley:route farm.forget DELETE /api/agents/{id}/memories/{memory}
	FarmForget(ctx context.Context, pID string, pMemory string) error
	//vibevalley:route farm.managerMemory GET /api/manager/memories
	FarmManagerMemory(ctx context.Context) (ManagerMemory, error)
	//vibevalley:route farm.managerRemember POST /api/manager/memories
	FarmManagerRemember(ctx context.Context, body MemoryRequest) (Memory, error)
	//vibevalley:route farm.managerForget DELETE /api/manager/memories/{memory}
	FarmManagerForget(ctx context.Context, pMemory string) error
	//vibevalley:route farm.managerArchive GET /api/manager/archive
	FarmManagerArchive(ctx context.Context, pQ *string) (ArchiveListing, error)
	//vibevalley:route farm.managerArchiveFile GET /api/manager/archive/{name}
	FarmManagerArchiveFile(ctx context.Context, pName string) (string, error)
	//vibevalley:route farm.skills GET /api/skills
	FarmSkills(ctx context.Context) ([]Skill, error)
	//vibevalley:route farm.saveSkill PUT /api/skills/{id}
	FarmSaveSkill(ctx context.Context, pID string, body Skill) (Skill, error)
	//vibevalley:route farm.deleteSkill DELETE /api/skills/{id}
	FarmDeleteSkill(ctx context.Context, pID string) error
	//vibevalley:route farm.projects GET /api/projects
	FarmProjects(ctx context.Context) ([]ProjectSummary, error)
	//vibevalley:route farm.createProject POST /api/projects
	FarmCreateProject(ctx context.Context, body NewProject) (ProjectSummary, error)
	//vibevalley:route farm.projectLanguages GET /api/projects/{id}/languages
	FarmProjectLanguages(ctx context.Context, pID string) (ProjectLanguages, error)
	//vibevalley:route farm.projectActivity GET /api/projects/{id}/activity
	FarmProjectActivity(ctx context.Context, pID string) (ProjectActivity, error)
	//vibevalley:route voice.session POST /api/voice/session
	VoiceSession(ctx context.Context) (VoiceSession, error)
	//vibevalley:route voice.renew POST /api/voice/renew
	VoiceRenew(ctx context.Context, body RenewRequest) (VoiceSession, error)
	//vibevalley:route voice.start POST /api/voice/agent
	VoiceStart(ctx context.Context, body StartRequest) (VoiceAgent, error)
	//vibevalley:route voice.stop POST /api/voice/agent/stop
	VoiceStop(ctx context.Context, body VoiceAgent) error
	//vibevalley:route connectors.list GET /api/connectors
	ConnectorsList(ctx context.Context) ([]ConnectorStatus, error)
	//vibevalley:route connectors.login POST /api/connectors/{id}/login
	ConnectorsLogin(ctx context.Context, pID ConnectorID, body ConnectorLogin) (ConnectorStatus, error)
	//vibevalley:route connectors.verify POST /api/connectors/{id}/verify
	ConnectorsVerify(ctx context.Context, pID ConnectorID, body VerifyRequest) (ConnectorStatus, error)
	//vibevalley:route connectors.logout POST /api/connectors/{id}/logout
	ConnectorsLogout(ctx context.Context, pID ConnectorID) (ConnectorStatus, error)
	//vibevalley:route connectors.channel PUT /api/connectors/{id}/channel
	ConnectorsChannel(ctx context.Context, pID ConnectorID, body ConnectorsChannelRequest) (ConnectorStatus, error)
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
