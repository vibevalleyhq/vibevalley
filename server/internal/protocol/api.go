package protocol

import "context"

// One method each, so a new endpoint fails the build until it is answered. vibevalley:route is the operation (group.name, the Flutter client's
// api.group.name), method and path; vibevalley:can is who may call it: owner (on the farm's machine), remote (a device through the
// lan listener, which lets only these through), manager (its tools), session (a session, with its key). The table is Endpoints in gen.go and
// docs/reference/capabilities.md.
type Handlers interface {
	//vibevalley:route server.health GET /api/v1/health
	//vibevalley:can owner remote
	ServerHealth(ctx context.Context) (Health, error)
	//vibevalley:route manager.open POST /api/v1/manager/open
	//vibevalley:can owner remote
	ManagerOpen(ctx context.Context) error
	// Ends the manager's run under way and drops what waits for it; the sessions it sent keep working.
	//vibevalley:route manager.stop POST /api/v1/manager/stop
	//vibevalley:can owner remote
	ManagerStop(ctx context.Context) error
	//vibevalley:route setting.load GET /api/v1/settings
	//vibevalley:can owner remote
	SettingLoad(ctx context.Context) (SettingsStatus, error)
	// The first thing Save would refuse in these settings, without saving them.
	//vibevalley:route setting.check POST /api/v1/settings/check
	//vibevalley:can owner remote
	SettingCheck(ctx context.Context, body SettingsUpdate) (SettingsCheck, error)
	//vibevalley:route setting.save PUT /api/v1/settings
	//vibevalley:can owner
	SettingSave(ctx context.Context, body SettingsUpdate) (SettingsStatus, error)
	//vibevalley:route channel.say POST /api/v1/say
	//vibevalley:can owner remote
	ChannelSay(ctx context.Context, body SayRequest) error
	//vibevalley:route channel.create POST /api/v1/channels
	//vibevalley:can owner remote manager
	ChannelCreate(ctx context.Context, body ChannelRequest) (string, error)
	//vibevalley:route schedule.create POST /api/v1/schedules
	//vibevalley:can owner remote manager
	ScheduleCreate(ctx context.Context, body ScheduleRequest) (Schedule, error)
	//vibevalley:route schedule.list GET /api/v1/schedules
	//vibevalley:can owner remote manager
	ScheduleList(ctx context.Context) ([]Schedule, error)
	// Only what the body gives changes.
	//vibevalley:route schedule.update PUT /api/v1/schedules/{id}
	//vibevalley:can owner remote
	ScheduleUpdate(ctx context.Context, pID string, body ScheduleUpdate) error
	//vibevalley:route schedule.delete DELETE /api/v1/schedules/{id}
	//vibevalley:can owner remote manager
	ScheduleDelete(ctx context.Context, pID string) error
	//vibevalley:route channel.update PUT /api/v1/channels/{id}
	//vibevalley:can owner remote manager
	ChannelUpdate(ctx context.Context, pID string, body ChannelUpdate) error
	// The v1 caption relay without a call id is accepted only with one active call.
	//vibevalley:route manager.hear POST /api/v1/manager/hear
	//vibevalley:can owner remote
	ManagerHear(ctx context.Context, body SayRequest) error
	// To the issue's newest session, as the owner: a comment is on the issue, not on one step. A closed issue is refused: reopen it.
	//vibevalley:route issue.comment POST /api/v1/issues/{id}/comment
	//vibevalley:can owner remote manager
	IssueComment(ctx context.Context, pID string, body CommentRequest) error
	//vibevalley:route issue.changes GET /api/v1/issues/{id}/changes
	//vibevalley:can owner remote manager
	IssueChanges(ctx context.Context, pID string) (Changes, error)
	// Tells the newest session to merge its base in and settle the conflicts, in the owner's words (ConflictTask).
	//vibevalley:route issue.resolve POST /api/v1/issues/{id}/resolve
	//vibevalley:can owner remote
	IssueResolve(ctx context.Context, pID string) error
	// Stops a session's turn; it stays, and a comment starts the next.
	//vibevalley:route session.stop POST /api/v1/sessions/{id}/stop
	//vibevalley:can owner remote manager
	SessionStop(ctx context.Context, pID string) error
	//vibevalley:route session.list GET /api/v1/sessions
	//vibevalley:can owner remote
	SessionList(ctx context.Context, pAgent *string) ([]Session, error)
	//vibevalley:route session.get GET /api/v1/sessions/{id}
	//vibevalley:can owner remote
	SessionGet(ctx context.Context, pID string) (Session, error)
	// Its log, oldest first; run gives one run's only. The manager's log is session manager's.
	//vibevalley:route session.events GET /api/v1/sessions/{id}/events
	//vibevalley:can owner remote
	SessionEvents(ctx context.Context, pID string, pRun *string) ([]SessionEvent, error)
	// One joined read of issues and their real sessions, including explicit missing records.
	//vibevalley:route issue.history GET /api/v1/issues/history
	//vibevalley:can owner remote manager
	IssueHistory(ctx context.Context) ([]IssueHistory, error)
	//vibevalley:route issue.list GET /api/v1/issues
	//vibevalley:can owner remote
	IssueList(ctx context.Context) ([]Issue, error)
	//vibevalley:route issue.get GET /api/v1/issues/{id}
	//vibevalley:can owner remote
	IssueGet(ctx context.Context, pID string) (Issue, error)
	//vibevalley:route issue.runs GET /api/v1/issues/{id}/runs
	//vibevalley:can owner remote
	IssueRuns(ctx context.Context, pID string) ([]Run, error)
	//vibevalley:route issue.create POST /api/v1/issues
	//vibevalley:can owner remote
	IssueCreate(ctx context.Context, body IssueRequest) (Issue, error)
	//vibevalley:route issue.update PUT /api/v1/issues/{id}
	//vibevalley:can owner remote
	IssueUpdate(ctx context.Context, pID string, body IssueUpdate) (Issue, error)
	//vibevalley:route issue.delete DELETE /api/v1/issues/{id}
	//vibevalley:can owner remote
	IssueDelete(ctx context.Context, pID string) error
	//vibevalley:route issue.move PUT /api/v1/issues/{id}/move
	//vibevalley:can owner remote
	IssueMove(ctx context.Context, pID string, body MoveIssueRequest) ([]Issue, error)
	// Moving an issue is what it does: todo sends it out (or waits for room), done merges, canceled sends its session home,
	// todo again after a round or a close is another round with text. Issue.moves lists where it may go.
	//vibevalley:route issue.status PUT /api/v1/issues/{id}/status
	//vibevalley:can owner remote
	IssueStatus(ctx context.Context, pID string, body IssueStatusRequest) (Issue, error)
	// A session reads the code and writes the backlog issue to the issue's format (title, description, criteria), then
	// leaves; with asks open, the word is their answer. The issue stays in the backlog until it is moved to todo.
	//vibevalley:route issue.draft POST /api/v1/issues/{id}/draft
	//vibevalley:can owner remote
	IssueDraft(ctx context.Context, pID string, body IssueDraftRequest) (Issue, error)
	// Starts a queued todo now, if its project and the farm have room; otherwise it keeps its place in the queue.
	//vibevalley:route issue.dispatch POST /api/v1/issues/{id}/dispatch
	//vibevalley:can owner remote
	IssueDispatch(ctx context.Context, pID string, body IssueDispatchRequest) (Dispatched, error)
	// The acceptance of what was handed back (in review): a pass makes it ready to harvest, a fail adds weeds and sends
	// another round.
	//vibevalley:route issue.accept POST /api/v1/issues/{id}/accept
	//vibevalley:can owner remote manager
	IssueAccept(ctx context.Context, pID string, body IssueAcceptRequest) (Issue, error)
	//vibevalley:route graph.split POST /api/v1/graphs
	//vibevalley:can owner remote manager
	GraphSplit(ctx context.Context, body GraphSplitRequest) (string, error)
	//vibevalley:route graph.updateTask PUT /api/v1/graphs/{id}/tasks/{task}
	//vibevalley:can owner remote manager
	GraphUpdateTask(ctx context.Context, pID string, pTask string, body TaskEdit) (string, error)
	//vibevalley:route graph.deleteTask DELETE /api/v1/graphs/{id}/tasks/{task}
	//vibevalley:can owner remote manager
	GraphDeleteTask(ctx context.Context, pID string, pTask string) (string, error)
	//vibevalley:route graph.act POST /api/v1/graphs/{id}/act
	//vibevalley:can owner remote manager
	GraphAct(ctx context.Context, pID string, body GraphActRequest) (string, error)
	//vibevalley:route graph.taskAct POST /api/v1/graphs/{id}/tasks/{task}/act
	//vibevalley:can owner remote manager
	GraphTaskAct(ctx context.Context, pID string, pTask string, body TaskActRequest) (string, error)
	//vibevalley:route channel.history GET /api/v1/channels/{id}/messages
	//vibevalley:can owner remote manager
	ChannelHistory(ctx context.Context, pID string, pBefore *int64, pLimit *int64) ([]ChatMessage, error)
	//vibevalley:route channel.markRead POST /api/v1/channels/{id}/read
	//vibevalley:can owner remote
	ChannelMarkRead(ctx context.Context, pID string, body ChatReadRequest) error
	//vibevalley:route graph.changes GET /api/v1/graphs/{id}/changes
	//vibevalley:can owner remote
	GraphChanges(ctx context.Context, pID string) (Changes, error)
	//vibevalley:route graph.events GET /api/v1/graphs/{id}/events
	//vibevalley:can owner remote
	GraphEvents(ctx context.Context, pID string) ([]GraphEvent, error)
	//vibevalley:route game.achievements GET /api/v1/game/achievements
	//vibevalley:can owner remote
	GameAchievements(ctx context.Context) ([]Achievement, error)
	//vibevalley:route game.chooseTitle POST /api/v1/game/title
	//vibevalley:can owner remote
	GameChooseTitle(ctx context.Context, body ChooseTitleRequest) error
	//vibevalley:route runtime.list GET /api/v1/runtimes
	//vibevalley:can owner remote
	RuntimeList(ctx context.Context) ([]RuntimeInfo, error)
	//vibevalley:route github.status GET /api/v1/github
	//vibevalley:can owner remote
	GithubStatus(ctx context.Context) (GitHubStatus, error)
	//vibevalley:route github.refresh POST /api/v1/github/refresh
	//vibevalley:can owner remote
	GithubRefresh(ctx context.Context) (GitHubStatus, error)
	//vibevalley:route runtime.refresh POST /api/v1/runtimes/{id}/refresh
	//vibevalley:can owner remote
	RuntimeRefresh(ctx context.Context, pID string) (RuntimeInfo, error)
	//vibevalley:route runtime.update PUT /api/v1/runtimes/{id}/settings
	//vibevalley:can owner
	RuntimeUpdate(ctx context.Context, pID string, body RuntimeSettings) (RuntimeInfo, error)
	//vibevalley:route agent.list GET /api/v1/agents
	//vibevalley:can owner remote
	AgentList(ctx context.Context) ([]Agent, error)
	// The issues of each profile as it would be dispatched now; a draft not saved yet too.
	//vibevalley:route agent.check POST /api/v1/agents/check
	//vibevalley:can owner remote
	AgentCheck(ctx context.Context, body AgentCheckRequest) ([]AgentCheck, error)
	// Create allocates an identity; callers with an existing identity use save.
	//vibevalley:route agent.create POST /api/v1/agents
	//vibevalley:can owner manager
	AgentCreate(ctx context.Context, body Agent) (Agent, error)
	//vibevalley:route agent.save PUT /api/v1/agents/{id}
	//vibevalley:can owner
	AgentSave(ctx context.Context, pID string, body Agent) (Agent, error)
	//vibevalley:route agent.delete DELETE /api/v1/agents/{id}
	//vibevalley:can owner
	AgentDelete(ctx context.Context, pID string) error
	// An agent's memories: the manager's (agent manager) are the lines of its MEMORY.md, with the file and how many of the newest
	// its prompt carries; every other agent's are rows.
	//vibevalley:route memory.list GET /api/v1/memories/{agent}
	//vibevalley:can owner remote
	MemoryList(ctx context.Context, pAgent string) (MemoryList, error)
	// What the agent would be reminded of on its next start; the manager is not reminded, it carries its whole file.
	//vibevalley:route memory.recall GET /api/v1/memories/{agent}/recall
	//vibevalley:can owner remote
	MemoryRecall(ctx context.Context, pAgent string, pProject *string, pText *string) (RecallPreview, error)
	//vibevalley:route memory.create POST /api/v1/memories/{agent}
	//vibevalley:can owner remote manager
	MemoryCreate(ctx context.Context, pAgent string, body MemoryRequest) (Memory, error)
	//vibevalley:route memory.delete DELETE /api/v1/memories/{agent}/{memory}
	//vibevalley:can owner remote
	MemoryDelete(ctx context.Context, pAgent string, pMemory string) error
	//vibevalley:route manager.listArchive GET /api/v1/manager/archive
	//vibevalley:can owner remote manager
	ManagerListArchive(ctx context.Context, pQ *string) (ArchiveListing, error)
	//vibevalley:route manager.getArchive GET /api/v1/manager/archive/{name}
	//vibevalley:can owner remote
	ManagerGetArchive(ctx context.Context, pName string) (string, error)
	// Saves the turn begun at a step of the manager's log as a case for its evals, with what it should have done.
	//vibevalley:route manager.markWrong POST /api/v1/manager/evals
	//vibevalley:can owner remote
	ManagerMarkWrong(ctx context.Context, body ManagerEvalRequest) (ManagerEval, error)
	//vibevalley:route skill.list GET /api/v1/skills
	//vibevalley:can owner remote
	SkillList(ctx context.Context) ([]Skill, error)
	// Create allocates an identity; callers with an existing identity use save.
	//vibevalley:route skill.create POST /api/v1/skills
	//vibevalley:can owner manager
	SkillCreate(ctx context.Context, body Skill) (Skill, error)
	//vibevalley:route skill.save PUT /api/v1/skills/{id}
	//vibevalley:can owner
	SkillSave(ctx context.Context, pID string, body Skill) (Skill, error)
	//vibevalley:route skill.delete DELETE /api/v1/skills/{id}
	//vibevalley:can owner
	SkillDelete(ctx context.Context, pID string) error
	//vibevalley:route project.list GET /api/v1/projects
	//vibevalley:can owner remote manager
	ProjectList(ctx context.Context) ([]ProjectSummary, error)
	// The first thing Create would refuse in this project, without making it.
	//vibevalley:route project.check POST /api/v1/projects/check
	//vibevalley:can owner remote
	ProjectCheck(ctx context.Context, body NewProject) (ProjectCheck, error)
	//vibevalley:route project.create POST /api/v1/projects
	//vibevalley:can owner remote
	ProjectCreate(ctx context.Context, body NewProject) (ProjectSummary, error)
	//vibevalley:route project.languages GET /api/v1/projects/{id}/languages
	//vibevalley:can owner remote
	ProjectLanguages(ctx context.Context, pID string) (ProjectLanguages, error)
	// The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it.
	//vibevalley:route project.templates GET /api/v1/projects/{id}/templates
	//vibevalley:can owner remote
	ProjectTemplates(ctx context.Context, pID string) (ProjectTemplates, error)
	//vibevalley:route project.activity GET /api/v1/projects/{id}/activity
	//vibevalley:can owner remote
	ProjectActivity(ctx context.Context, pID string) (ProjectActivity, error)
	//vibevalley:route voice.session POST /api/v1/voice/session
	//vibevalley:can owner remote
	VoiceSession(ctx context.Context) (AgoraGrant, error)
	//vibevalley:route voice.renew POST /api/v1/voice/renew
	//vibevalley:can owner remote
	VoiceRenew(ctx context.Context, body RenewRequest) (AgoraGrant, error)
	//vibevalley:route voice.start POST /api/v1/voice/agent
	//vibevalley:can owner remote
	VoiceStart(ctx context.Context, body StartRequest) (VoiceAgent, error)
	//vibevalley:route voice.stop POST /api/v1/voice/agent/stop
	//vibevalley:can owner remote
	VoiceStop(ctx context.Context, body VoiceAgent) error
	//vibevalley:route voice.heard POST /api/v1/voice/agent/heard
	//vibevalley:can owner remote
	VoiceHeard(ctx context.Context, body VoiceHeard) error
	//vibevalley:route voice.said POST /api/v1/voice/agent/said
	//vibevalley:can owner remote
	VoiceSaid(ctx context.Context, body VoiceSaid) error
	//vibevalley:route voice.dictate POST /api/v1/voice/dictate
	//vibevalley:can owner remote
	VoiceDictate(ctx context.Context, body DictateRequest) (Dictated, error)
	//vibevalley:route connector.list GET /api/v1/connectors
	//vibevalley:can owner remote
	ConnectorList(ctx context.Context) ([]ConnectorStatus, error)
	//vibevalley:route connector.login POST /api/v1/connectors/{id}/login
	//vibevalley:can owner
	ConnectorLogin(ctx context.Context, pID ConnectorID, body ConnectorLogin) (ConnectorStatus, error)
	//vibevalley:route connector.verify POST /api/v1/connectors/{id}/verify
	//vibevalley:can owner
	ConnectorVerify(ctx context.Context, pID ConnectorID, body VerifyRequest) (ConnectorStatus, error)
	//vibevalley:route connector.logout POST /api/v1/connectors/{id}/logout
	//vibevalley:can owner
	ConnectorLogout(ctx context.Context, pID ConnectorID) (ConnectorStatus, error)
	//vibevalley:route connector.channel PUT /api/v1/connectors/{id}/channel
	//vibevalley:can owner
	ConnectorChannel(ctx context.Context, pID ConnectorID, body ConnectorsChannelRequest) (ConnectorStatus, error)
	//vibevalley:route lan.status GET /api/v1/lan
	//vibevalley:can owner
	LanStatus(ctx context.Context) (LanStatus, error)
	//vibevalley:route lan.update PUT /api/v1/lan
	//vibevalley:can owner
	LanUpdate(ctx context.Context, body SetOpenRequest) (LanStatus, error)
	//vibevalley:route lan.startPairing POST /api/v1/lan/pairing
	//vibevalley:can owner
	LanStartPairing(ctx context.Context) (LanStatus, error)
	//vibevalley:route lan.stopPairing DELETE /api/v1/lan/pairing
	//vibevalley:can owner
	LanStopPairing(ctx context.Context) (LanStatus, error)
	//vibevalley:route lan.answerPairing POST /api/v1/lan/pairing/answer
	//vibevalley:can owner
	LanAnswerPairing(ctx context.Context, body AnswerPairingRequest) (LanStatus, error)
	//vibevalley:route lan.deleteDevice DELETE /api/v1/lan/devices/{id}
	//vibevalley:can owner
	LanDeleteDevice(ctx context.Context, pID string) (LanStatus, error)
	//vibevalley:route lan.pair POST /api/v1/lan/pair
	//vibevalley:can owner remote
	LanPair(ctx context.Context, body LanPairRequest) (LanPaired, error)
	//vibevalley:route lan.me GET /api/v1/lan/me
	//vibevalley:can owner remote
	LanMe(ctx context.Context) (LanDevice, error)
	// The documents, the newest change first; their blocks are in doc.get.
	//vibevalley:route doc.list GET /api/v1/docs
	//vibevalley:can owner remote
	DocList(ctx context.Context) ([]Document, error)
	//vibevalley:route doc.create POST /api/v1/docs
	//vibevalley:can owner remote
	DocCreate(ctx context.Context, body DocRequest) (DocSnapshot, error)
	// A new document from Markdown: the format documents trade with agents and MEMORY.md in, not how they are stored.
	//vibevalley:route doc.import POST /api/v1/docs/import
	//vibevalley:can owner remote
	DocImport(ctx context.Context, body DocImport) (DocSnapshot, error)
	// The document and every live block (no tombstones), in order.
	//vibevalley:route doc.get GET /api/v1/docs/{id}
	//vibevalley:can owner remote
	DocGet(ctx context.Context, pID string) (DocSnapshot, error)
	// A batch of ops, as the owner: taken in order, in one transaction, one batch of a document at a time.
	//vibevalley:route doc.submit POST /api/v1/docs/{id}/submit
	//vibevalley:can owner remote
	DocSubmit(ctx context.Context, pID string, body DocSubmit) (DocAck, error)
	//vibevalley:route doc.markdown GET /api/v1/docs/{id}/markdown
	//vibevalley:can owner remote
	DocMarkdown(ctx context.Context, pID string) (DocMarkdown, error)
	// Starts the scripted demo (up to three helpers writing their own sections at once, no model) and returns at once;
	// one already running is refused.
	//vibevalley:route doc.demo POST /api/v1/docs/{id}/demo
	//vibevalley:can owner
	DocDemo(ctx context.Context, pID string) error
}
