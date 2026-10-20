import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/composer.dart' show ComposerDraft;
import '../../rules/time.dart';
import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../rules/issues.dart';
import '../../data/ui_state.dart' show titleOpenProvider, farmOverlaysProvider;
import '../../ui/pro/pro.dart';
import '../projects/new_project_dialog.dart' show showNewProjectDialog;
import '../../data/remote.dart';
import '../shared/composer.dart';
import '../shared/widgets.dart';
import '../shared/config_problem.dart';
import 'harvest_review.dart';
import 'issue_panel.dart';
import 'issues_page.dart';
import 'issue_submission.dart';

/// Closing an issue: harvest it (its checklist first) or let the helper go. Wider than a form: the checklist lists files and patches.
Future<void> showCloseIssueDialog(BuildContext context, Issue issue, Session session) => showProDialog<void>(
  context,
  title: Text('关上「${issueTitle(issue)}」'),
  maxWidth: 680,
  builder: (_) => CloseIssue(session: session),
);

class CloseIssue extends ConsumerStatefulWidget {
  const CloseIssue({super.key, required this.session});
  final Session session;

  @override
  ConsumerState<CloseIssue> createState() => _CloseIssueState();
}

class _CloseIssueState extends ConsumerState<CloseIssue> {
  bool _review = false;

  @override
  Widget build(BuildContext context) {
    final session = widget.session;
    void done() => Navigator.of(context).pop();
    if (_review) return HarvestReview(session: session, onDone: done);
    final working = session.phase is PhaseWorking || session.phase is PhaseArriving;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          working ? '${session.name} 还在干这张工单。关上就是叫停它、让它收工，分支上的改动不合进主分支。' : '收获就是把 ${session.name} 的分支合进项目的主分支，先看一遍收成清单；不收就是让它收工，改动不合进去。',
          style: ProText.base,
        ),
        const SizedBox(height: 20),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (!working) ProButton.text('看收成清单，收获', tone: ProTone.primary, onPressed: () => setState(() => _review = true)),
            ProButton.text(
              working ? '叫停并收工' : '不收，直接收工',
              tone: ProTone.danger,
              onPressed: () async {
                await runAction(
                  () => ref
                      .read(apiProvider)
                      .issue
                      .status(
                        id: session.issueId,
                        body: const IssueStatusRequest(status: IssueStatus.canceled),
                      ),
                );
                done();
              },
            ),
            ProButton.text('算了', onPressed: done),
          ],
        ),
      ],
    );
  }
}

class ReopenForm extends StatefulWidget {
  const ReopenForm({super.key, required this.issue});
  final Issue issue;

  @override
  State<ReopenForm> createState() => _ReopenFormState();
}

class _ReopenFormState extends State<ReopenForm> {
  String _text = '';

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Text('「${issueTitle(widget.issue)}」由同一个帮工档案的新帮工接着做，它会知道这张工单原来要做什么、上一次是怎么关的。', style: ProText.base),
      const SizedBox(height: 16),
      ProTextArea(
        value: _text,
        onChanged: (v) => setState(() => _text = v),
        rows: 3,
        autofocus: true,
        placeholder: '这次要它做什么（不填就是接着做完）',
        semanticLabel: '这次要做什么',
      ),
      const SizedBox(height: 20),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          ProButton.text('算了', onPressed: () => Navigator.of(context).pop()),
          const SizedBox(width: 8),
          ProButton.text('重开', tone: ProTone.primary, onPressed: () => Navigator.of(context).pop(_text.trim())),
        ],
      ),
    ],
  );
}

/// An issue not sent yet. In the backlog it is a draft: the box says what is wanted (or answers what its drafter asked)
/// and sends a helper to draft it; the fields are the draft, each editable; 开工 sends it out.
class TodoDetail extends ConsumerStatefulWidget {
  const TodoDetail({super.key, required this.item, required this.reload, required this.onDone});
  final Issue item;
  final Future<void> Function() reload;
  final ValueChanged<String?> onDone;

  @override
  ConsumerState<TodoDetail> createState() => _TodoState();
}

class _TodoState extends ConsumerState<TodoDetail> {
  late String _title;
  late String _description;
  late String _criteria;
  late String _project;
  late String _agent;
  late Priority _priority;
  late Acceptance _acceptance;
  final _word = ComposerDraft();
  // Until the owner edits a field, a draft coming back fills them.
  var _edited = false;
  var _busy = false;
  late final IssueSubmission _submission;

  void _take(Issue i) {
    _title = i.title;
    _description = i.description ?? '';
    _criteria = (i.criteria ?? const <String>[]).join('\n');
    _project = i.project ?? '';
    _agent = i.assignee ?? '';
    _priority = i.priority;
    _acceptance = i.acceptance;
  }

  void _edit(VoidCallback change) => setState(() {
    change();
    _edited = true;
  });

  Future<void> _newProject(BuildContext context) async {
    final made = await showNewProjectDialog(context);
    if (made != null && mounted) _edit(() => _project = made.name);
  }

  IssueRequest get _request => IssueRequest(
    title: _title,
    description: _description,
    project: _project.isEmpty ? null : _project,
    assignee: _agent.isEmpty ? null : _agent,
    priority: _priority,
    acceptance: _acceptance,
  );

  List<String> get _criteriaList => [
    for (final line in _criteria.split('\n'))
      if (line.trim().isNotEmpty) line.trim(),
  ];

  Future<void> _run(Future<void> Function() act) async {
    setState(() => _busy = true);
    await runAction(act);
    await widget.reload();
    if (mounted) setState(() => _busy = false);
  }

  @override
  void initState() {
    super.initState();
    _word.addListener(() => setState(() {}));
    _take(widget.item);
    _submission = IssueSubmission(ref.read(apiProvider).issue, initial: widget.item);
  }

  @override
  void didUpdateWidget(TodoDetail old) {
    super.didUpdateWidget(old);
    if (!_edited) _take(widget.item);
  }

  Future<void> _save() => _run(() async {
    await _submission.save(_request, criteria: _criteriaList);
    _edited = false;
  });

  @override
  void dispose() {
    _word.dispose();
    super.dispose();
  }

  /// Throws, so the box keeps the words and says why.
  Future<void> _draftWith(String text, String _) async {
    setState(() => _busy = true);
    try {
      await _submission.draft(_request, text, criteria: _criteriaList, edited: _edited);
      if (mounted) setState(() => _edited = false);
    } finally {
      await widget.reload();
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _draft() => _word.send(_draftWith, blank: true);

  Future<void> _start() => _run(() async {
    final got = await _submission.start(_request, criteria: _criteriaList);
    _edited = false;
    dispatchedNotice(got, widget.onDone);
  });

  @override
  Widget build(BuildContext context) {
    if (ref.watch(workbenchConfigProvider).error != null) return const ConfigProblem();
    final item = widget.item;
    final projects = ref.watch(projectNamesProvider).value ?? const <String>[];
    final agents = (ref.watch(workbenchConfigProvider).agents).where((a) => a.enabled).toList();
    final issues = watchAgentIssues(ref, agents);
    final ready = !_busy && _title.trim().isNotEmpty;
    final queued = item.queuedAt;
    final backlog = item.status == IssueStatus.backlog;
    final drafting = item.drafting;
    final drafted = isDrafted(item);
    final asks = item.asks;
    final (head, line) = switch (drafting) {
      final d? => ('${d.name}在起草', '它在读代码，写好了会填进下面各栏。'),
      null when asks.isNotEmpty => ('草稿写好了，它有 ${asks.length} 个问题要问你', '在下面回答，它照你的回答再起草一版。'),
      null when drafted => ('草稿写好了', '看一遍、改一改，没问题就开工。'),
      null => ('想做什么？', '写一句就行：帮工读过代码，替你写成工单。'),
    };
    final canDraft = !_busy && drafting == null && (drafted || !_word.empty || _title.trim() != newIssueTitle);
    final draft = !backlog
        ? null
        : Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              const IssueStages(Stage.talk),
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: BoxDecoration(
                  color: (drafting != null ? Palette.water : Palette.wheat).withValues(alpha: .16),
                  borderRadius: const BorderRadius.all(Radius.circular(8)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(head, style: ProText.base.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(line, style: ProText.sm),
                    for (final a in asks) Text('· $a', style: ProText.sm),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              WorkbenchComposer(
                draft: _word,
                mentions: false,
                sendButton: false,
                sendLabel: drafted ? '再起草' : '起草',
                onSend: canDraft ? _draftWith : null,
                autofocus: !drafted && drafting == null,
                placeholder: asks.isNotEmpty
                    ? '回答它的问题'
                    : drafted
                    ? '再起草时要它改什么（可以不写）'
                    : '想做什么，一句话就行',
                semanticLabel: '想做什么',
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  ProButton.text(drafted ? '再起草' : '起草', tone: drafted ? ProTone.plain : ProTone.primary, onPressed: canDraft ? _draft : null),
                  ProButton.text(
                    '开工',
                    tone: drafted ? ProTone.primary : ProTone.plain,
                    onPressed: ready && drafting == null && _agent.isNotEmpty ? _start : null,
                  ),
                ],
              ),
              const SizedBox(height: 20),
              const Divider(height: 1, thickness: 1, color: ProColor.line),
              const SizedBox(height: 20),
            ],
          );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        IssueHeading(backlog ? '草稿' : '待办', aside: Text('写于 ${wallClockText(item.createdAt)}')),
        const SizedBox(height: 16),
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            ?draft,
            ProField(
              label: '标题',
              child: ProTextInput(value: _title, onChanged: (v) => _edit(() => _title = v), placeholder: '比如：给登录页加上记住我', semanticLabel: '标题'),
            ),
            const SizedBox(height: 16),
            ProField(
              label: '说明',
              child: ProTextArea(
                value: _description,
                onChanged: (v) => _edit(() => _description = v),
                rows: 6,
                placeholder: '为什么、要做的、不做的、可能涉及哪些文件（起草会写好）',
                semanticLabel: '说明',
              ),
            ),
            const SizedBox(height: 16),
            ProField(
              label: '验收标准',
              child: ProTextArea(value: _criteria, onChanged: (v) => _edit(() => _criteria = v), rows: 3, placeholder: '一行一条：你验收时照着看的点', semanticLabel: '验收标准'),
            ),
            const SizedBox(height: 16),
            ProField(
              label: '优先级',
              child: ProSegmented<Priority>(
                value: _priority,
                options: [for (final p in Priority.values) SegmentOption(value: p, label: priorityLabel[p]!)],
                onChanged: (v) => _edit(() => _priority = v),
              ),
            ),
            const SizedBox(height: 12),
            // Every issue has an acceptance; this is who must pass it before the harvest.
            ProField(
              label: '验收',
              child: ProSegmented<Acceptance>(
                value: _acceptance,
                options: const [
                  SegmentOption(value: Acceptance.glance, label: '看一眼就收'),
                  SegmentOption(value: Acceptance.required, label: '必须过验收'),
                ],
                onChanged: (v) => _edit(() => _acceptance = v),
              ),
            ),
            const SizedBox(height: 16),
            ProField(
              label: '项目',
              hint: projects.isEmpty
                  ? InlineLink('工作目录里还没有项目：新建一个', onTap: () => _newProject(context))
                  : InlineLink('＋ 新建项目', onTap: () => _newProject(context)),
              child: ProPick(
                value: _project,
                placeholder: '在哪个项目里做',
                semanticLabel: '项目',
                options: [
                  for (final p in {...projects, if (_project.isNotEmpty) _project}) PickOption(value: p, label: p),
                ],
                onChanged: (v) => _edit(() => _project = v),
              ),
            ),
            const SizedBox(height: 16),
            ProField(
              label: '帮工',
              child: ProPick(
                value: _agent,
                placeholder: '派哪个帮工档案（起草时不选就替你挑）',
                semanticLabel: '帮工',
                options: [
                  for (final a in agents)
                    PickOption(
                      value: a.id,
                      label: a.name,
                      detail: switch ((issues[a.id] ?? const <AgentIssue>[]).where((i) => i.level == AgentIssueLevel.error).firstOrNull) {
                        final issue? => '派不出去：${issue.text}',
                        null => a.runtime,
                      },
                    ),
                ],
                onChanged: (v) => _edit(() => _agent = v),
              ),
            ),
            if (queued != null) ...[
              const SizedBox(height: 16),
              Container(
                decoration: BoxDecoration(color: Palette.water.withValues(alpha: .12), borderRadius: const BorderRadius.all(Radius.circular(8))),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    Expanded(child: Text('排队中：${ago(queued, DateTime.now().millisecondsSinceEpoch)}排上的，有空地就按看板上的先后自动开工。', style: ProText.sm)),
                    const SizedBox(width: 8),
                    ProButton.text(
                      '不排了',
                      size: ProSize.sm,
                      onPressed: _busy
                          ? null
                          : () => _run(
                              () => ref
                                  .read(apiProvider)
                                  .issue
                                  .status(
                                    id: item.id,
                                    body: const IssueStatusRequest(status: IssueStatus.backlog),
                                  ),
                            ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 20),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (queued != null) ProButton.text('现在就试', tone: ProTone.primary, onPressed: ready && _agent.isNotEmpty ? _start : null),
                ProButton.text('存下改动', onPressed: ready && _edited ? _save : null),
                ProButton.text(
                  '删掉',
                  tone: ProTone.danger,
                  onPressed: _busy
                      ? null
                      : () => _run(() async {
                          await ref.read(apiProvider).issue.delete(id: item.id);
                          widget.onDone(null);
                        }),
                ),
              ],
            ),
          ],
        ),
      ],
    );
  }
}

class IssueDetail extends ConsumerWidget {
  const IssueDetail({super.key, required this.issue, required this.sessions, required this.state, required this.session, required this.reload});
  final Issue issue;
  final List<Session> sessions;
  final IssueTag state;
  final Session? session;
  final Future<void> Function() reload;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Future<void> close(Session session) => showCloseIssueDialog(context, issue, session);

    return IssuePanel(
      issue: issue,
      sessions: sessions,
      state: state,
      session: session,
      reload: reload,
      onHarvest: close,
      onClose: close,
      onNavigate: session == null
          ? null
          : () {
              ref.read(titleOpenProvider.notifier).enterFarm(start: false);
              ref.read(farmOverlaysProvider.notifier).select(session!.id);
              workbenchGo(context, '/');
            },
    );
  }
}

/// An issue for the manager: what it was asked, and its runs; the answers are in its channel.
class ManagerIssueDetail extends StatelessWidget {
  const ManagerIssueDetail({super.key, required this.issue});
  final Issue issue;

  @override
  Widget build(BuildContext context) {
    final state = issueTag(issue);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        IssueHeading(issue.title, big: true, aside: Text(state.label)),
        const SizedBox(height: 16),
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            const KeyRow('谁在做', Text('管家')),
            if (issue.description case final d? when d.isNotEmpty) KeyRow('要做的', Text(d, style: ProText.base)),
            if (issue.schedule != null) const KeyRow('来自', Text('定时：每次到点重开这张工单，管家答完就关上')),
            KeyRow('开单', Text(wallClockText(issue.createdAt))),
            if (issue.closedAt != null) KeyRow('关单', Text(wallClockText(issue.closedAt!))),
            const KeyRow('回答', Text('在它的频道里')),
          ],
        ),
        IssueRuns(issue: issue.id, version: '${issue.status}:${issue.closedAt}', section: true),
      ],
    );
  }
}
