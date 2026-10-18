import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/issue_view.dart';
import '../../rules/time.dart';
import '../../data/providers.dart';
import '../../shared/harvest.dart' show HarvestReview;
import '../../gen/vibevalley.dart';
import '../../rules/issues.dart';
import '../../data/ui_state.dart' show titleOpenProvider, farmOverlaysProvider;
import '../../ui/kit/kit.dart';
import '../projects/new_project_dialog.dart' show showNewProjectDialog;
import '../../data/remote.dart';
import '../shared/widgets.dart';
import '../shared/config_problem.dart';
import 'issues_page.dart';
import 'issue_submission.dart';

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
          style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (!working) PxButton.text('看收成清单，收获', tone: PxTone.primary, onPressed: () => setState(() => _review = true)),
            PxButton.text(
              working ? '叫停并收工' : '不收，直接收工',
              tone: PxTone.danger,
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
            PxButton.text('算了', onPressed: done),
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
      Text('「${issueTitle(widget.issue)}」由同一个帮工档案的新帮工接着做，它会知道这张工单原来要做什么、上一次是怎么关的。', style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625)),
      const SizedBox(height: 12),
      PxTextArea(
        value: _text,
        onChanged: (v) => setState(() => _text = v),
        rows: 3,
        autofocus: true,
        placeholder: '这次要它做什么（不填就是接着做完）',
        semanticLabel: '这次要做什么',
      ),
      const SizedBox(height: 12),
      Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          PxButton.text('算了', onPressed: () => Navigator.of(context).pop()),
          const SizedBox(width: 8),
          PxButton.text('重开', tone: PxTone.primary, onPressed: () => Navigator.of(context).pop(_text.trim())),
        ],
      ),
    ],
  );
}

class TodoDetail extends ConsumerStatefulWidget {
  const TodoDetail({super.key, required this.item, this.project, required this.reload, required this.onDone});
  final Issue? item;

  final String? project;
  final Future<void> Function() reload;
  final ValueChanged<String?> onDone;

  @override
  ConsumerState<TodoDetail> createState() => _TodoState();
}

class _TodoState extends ConsumerState<TodoDetail> {
  late String _title = widget.item?.title ?? '';
  late String _description = widget.item?.description ?? '';
  late String _project = widget.item?.project ?? widget.project ?? '';
  late String _agent = widget.item?.assignee ?? '';
  late Priority _priority = widget.item?.priority ?? Priority.medium;
  bool _busy = false;
  late final IssueSubmission _submission;

  Future<void> _newProject(BuildContext context) async {
    final made = await showNewProjectDialog(context);
    if (made != null && mounted) setState(() => _project = made.name);
  }

  IssueRequest get _request => IssueRequest(
    title: _title,
    description: _description,
    project: _project.isEmpty ? null : _project,
    assignee: _agent.isEmpty ? null : _agent,
    priority: _priority,
  );

  Future<void> _run(Future<void> Function() act) async {
    setState(() => _busy = true);
    final done = await runAction(() async {
      await act();
      return true;
    });
    if (done != true && widget.item == null && _submission.saved != null && mounted) widget.onDone(_submission.saved!.id);
    await widget.reload();
    if (mounted) setState(() => _busy = false);
  }

  @override
  void initState() {
    super.initState();
    _submission = IssueSubmission(ref.read(apiProvider).issue, initial: widget.item);
    if (widget.item == null) {
      unawaited(
        IssueSubmission.remembered().then((pick) {
          if (!mounted) return;
          setState(() {
            if (_agent.isEmpty) _agent = pick.agent;
            if (_project.isEmpty) _project = pick.project;
          });
        }),
      );
    }
  }

  Future<void> _save() => _run(() async {
    final saved = await _submission.save(_request);
    if (widget.item == null) widget.onDone(saved.id);
  });

  Future<void> _start() => _run(() async {
    final got = await _submission.start(_request);
    dispatchedNotice(got, widget.onDone);
    if (got.status == IssueStatus.todo && widget.item == null) widget.onDone(got.id);
  });

  @override
  Widget build(BuildContext context) {
    if (ref.watch(workbenchConfigProvider).error != null) return const ConfigProblem();
    final projects = ref.watch(projectNamesProvider).value ?? const <String>[];
    final agents = (ref.watch(workbenchConfigProvider).agents).where((a) => a.enabled).toList();
    final issues = watchAgentIssues(ref, agents);
    final ready = !_busy && _title.trim().isNotEmpty;
    final queued = widget.item?.queuedAt;
    return PxCard(
      title: widget.item == null ? '写一张工单' : '待办',
      aside: widget.item == null ? null : Text('写于 ${wallClockText(widget.item!.createdAt)}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          PxField(
            label: '标题',
            child: PxTextInput(
              value: _title,
              onChanged: (v) => setState(() => _title = v),
              autofocus: widget.item == null,
              placeholder: '比如：给登录页加上记住我',
              semanticLabel: '标题',
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '说明',
            child: PxTextArea(
              value: _description,
              onChanged: (v) => setState(() => _description = v),
              rows: 5,
              placeholder: '做到什么程度算完、要注意什么（可以不写）',
              semanticLabel: '说明',
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '优先级',
            child: PxSegmented<Priority>(
              value: _priority,
              options: [for (final p in Priority.values) SegmentOption(value: p, label: priorityLabel[p]!)],
              onChanged: (v) => setState(() => _priority = v),
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '项目',
            hint: projects.isEmpty ? InlineLink('工作目录里还没有项目：新建一个', onTap: () => _newProject(context)) : InlineLink('＋ 新建项目', onTap: () => _newProject(context)),
            child: PxPick(
              value: _project,
              placeholder: '在哪个项目里做',
              semanticLabel: '项目',
              options: [
                for (final p in {...projects, if (_project.isNotEmpty) _project}) PickOption(value: p, label: p),
              ],
              onChanged: (v) => setState(() => _project = v),
            ),
          ),
          const SizedBox(height: 12),
          PxField(
            label: '帮工',
            child: PxPick(
              value: _agent,
              placeholder: '派哪个帮工档案',
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
              onChanged: (v) => setState(() => _agent = v),
            ),
          ),
          if (queued != null) ...[
            const SizedBox(height: 16),
            Container(
              color: Palette.water.withValues(alpha: .15),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      '排队中：${ago(queued, DateTime.now().millisecondsSinceEpoch)}排上的，有空地就按看板上的先后自动开工。',
                      style: KitText.sm.copyWith(color: Palette.bark800, height: 1.5),
                    ),
                  ),
                  const SizedBox(width: 8),
                  PxButton.text(
                    '不排了',
                    size: PxSize.sm,
                    onPressed: _busy
                        ? null
                        : () => _run(
                            () => ref
                                .read(apiProvider)
                                .issue
                                .status(
                                  id: widget.item!.id,
                                  body: const IssueStatusRequest(status: IssueStatus.backlog),
                                ),
                          ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              PxButton.text(queued != null ? '现在就试' : '开工', tone: PxTone.primary, onPressed: ready && _agent.isNotEmpty ? _start : null),
              PxButton.text(widget.item == null ? '先存着' : '存下改动', onPressed: ready ? _save : null),
              if (widget.item case final item?)
                PxButton.text(
                  '删掉',
                  tone: PxTone.danger,
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
    Future<void> close(Session session) async {
      await showFarmDialog<void>(
        context,
        title: Text('关上「${issueTitle(issue)}」'),
        size: FarmDialogSize.lg,
        icon: 'icon-harvest',
        builder: (_) => CloseIssue(session: session),
      );
    }

    return IssueView(
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

class _Row extends StatelessWidget {
  const _Row(this.label, this.child);
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(label, style: KitText.sm.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 12),
        Expanded(child: child),
      ],
    ),
  );
}

/// An issue for the manager: what it was asked, and its runs; the answers are in its channel.
class ManagerIssueDetail extends StatelessWidget {
  const ManagerIssueDetail({super.key, required this.issue});
  final Issue issue;

  @override
  Widget build(BuildContext context) {
    final state = issueTag(issue);
    final body = KitText.sm.copyWith(color: Palette.bark800);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        PxCard(
          title: issue.title,
          aside: Text(state.label),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              _Row('谁在做', Text('管家', style: body)),
              if (issue.description case final d? when d.isNotEmpty) _Row('要做的', Text(d, style: body.copyWith(height: 1.5))),
              if (issue.schedule != null) _Row('来自', Text('定时：每次到点重开这张工单，管家答完就关上', style: body)),
              _Row('开单', Text(wallClockText(issue.createdAt), style: body)),
              if (issue.closedAt != null) _Row('关单', Text(wallClockText(issue.closedAt!), style: body)),
              _Row('回答', Text('在它的频道里', style: body)),
            ],
          ),
        ),
        IssueRunsCard(issue: issue.id, version: '${issue.status}:${issue.closedAt}'),
      ],
    );
  }
}
