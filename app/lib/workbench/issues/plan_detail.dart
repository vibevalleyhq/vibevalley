import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/remote.dart' show agentsProvider, graphChangesProvider, reasonOf;
import '../../game/commands.dart' show farmCommandsProvider;
import '../../data/ui_state.dart' show FarmPanel, graphShownProvider, titleOpenProvider, farmOverlaysProvider;
import '../../gen/vibevalley.dart';
import '../../rules/issues.dart' show taskLine;
import '../../rules/money.dart' show spentText;
import '../../rules/task.dart';
import '../../rules/time.dart' show wallClockText;
import '../../shared/harvest_rules.dart' show lineCounts;
import '../../ui/pro/pro.dart';
import 'harvest_review.dart' show FileRow, PlusMinus;
import 'issue_sheet.dart';

/// A plan: an issue whose work is split into steps, each its own issue, run in the order their needs allow. It is read like
/// any issue (what it is for on the left, its state and actions on the right), with its steps listed under it.
class PlanDetail extends ConsumerStatefulWidget {
  const PlanDetail({super.key, required this.graph, required this.stepIssues, required this.onOpen});
  final TaskGraph graph;

  /// A step's own issue, by the step's id, once a helper has worked it: it opens like any issue.
  final Map<String, String> stepIssues;
  final ValueChanged<String?> onOpen;

  @override
  ConsumerState<PlanDetail> createState() => _PlanDetailState();
}

class _PlanDetailState extends ConsumerState<PlanDetail> {
  Answer? _said;
  var _reviewing = false;

  Future<void> _act(GraphAction action) async {
    final a = await ref.read(farmCommandsProvider).actOnGraph(widget.graph.id, action);
    if (mounted) setState(() => _said = a);
  }

  Future<void> _actOnStep(Task task, TaskAction action) async {
    final a = await ref.read(farmCommandsProvider).actOnTask(widget.graph.id, task.id, action);
    if (mounted) setState(() => _said = a);
  }

  Future<void> _abandon() async {
    final sure = await showProDialog<bool>(
      context,
      title: Text('${_word(GraphAction.abandon)}这个计划？'),
      builder: (context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('还没做完的步骤不再派出去；计划分支留着，做好的提交都还在。'),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              ProButton.text('算了', onPressed: () => Navigator.of(context).pop(false)),
              const SizedBox(width: 8),
              ProButton.text('确定放弃', tone: ProTone.danger, onPressed: () => Navigator.of(context).pop(true)),
            ],
          ),
        ],
      ),
    );
    if (sure == true) await _act(GraphAction.abandon);
  }

  String _word(GraphAction a) => widget.graph.actionText?[a.wire] ?? '';

  /// Steps and changes are edited on the farm's plan board, where they are laid out to be dragged and written.
  void _toFarmBoard() {
    ref.read(graphShownProvider.notifier).set(widget.graph.id);
    ref.read(farmOverlaysProvider.notifier).panel(FarmPanel.taskBoard);
    ref.read(titleOpenProvider.notifier).enterFarm(start: false);
    context.go('/');
  }

  @override
  Widget build(BuildContext context) {
    final graph = widget.graph;
    final total = graph.tasks.length;
    final settled = (graph.settled ?? 0).round();
    final agents = ref.watch(agentsProvider).value ?? const <String, Agent>{};
    final byId = {for (final t in graph.tasks) t.id: t};
    // The order they can run in; before the server has laid them out, the order they were written in.
    final layers = (graph.layers?.isNotEmpty ?? false)
        ? graph.layers!
        : [
            for (final t in graph.tasks) [t.id],
          ];
    final actions = graph.actions ?? const <GraphAction>[];

    final heading = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 11),
          child: Row(
            children: [
              ProTag(label: '计划', fill: Palette.leaf300.withValues(alpha: .5), icon: 'icon-tasks'),
              const SizedBox(width: 8),
              Text('$total 步', style: ProText.meta),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 11),
          child: Text(graph.title, style: ProText.xl),
        ),
        if (graph.goal.isNotEmpty && graph.goal != graph.title)
          Padding(padding: const EdgeInsets.fromLTRB(11, 8, 11, 0), child: ProClampedMarkdown(graph.goal)),
      ],
    );

    final main = <Widget>[
      // Running, the bar already says how far; otherwise the state's own words.
      _Progress(settled: settled, total: total, line: graph.state == GraphState.running ? '' : taskLine(graph)),
      if (graph.asksForYou == true) ...[const SizedBox(height: 10), _Note('有一步在等你：打开它回答或者验收。', Palette.wheat)],
      if (graph.state == GraphState.splitting) ...[const SizedBox(height: 10), _Note('管家在把它拆成步骤，拆好了会列在下面。', Palette.water)],
      if (_said case final said?) ...[const SizedBox(height: 10), _Note(said.text, said.ok ? Palette.leaf300 : Palette.berry)],
      if (_reviewing) ...[
        const SizedBox(height: 16),
        _PlanHarvest(
          graph: graph,
          onDone: (answer) => setState(() {
            _reviewing = false;
            if (answer != null) _said = answer;
          }),
        ),
      ],
      const SizedBox(height: 16),
      for (final (i, layer) in layers.indexed) ...[
        if (layers.length > 1) SheetLabel(layer.length > 1 ? '第 ${i + 1} 批 · 这 ${layer.length} 步可以同时做' : '第 ${i + 1} 批', top: i == 0 ? 0 : 12),
        for (final (j, id) in layer.indexed)
          if (byId[id] case final task?)
            _StepRow(
              task: task,
              graph: graph,
              agent: task.agent == null ? null : agents[task.agent]?.name ?? task.agent,
              waitsOn: [for (final b in task.blockedBy ?? const <String>[]) byId[b]?.title ?? b],
              issue: widget.stepIssues[task.id],
              last: i == layers.length - 1 && j == layer.length - 1,
              onOpen: widget.onOpen,
              onAct: (a) => _actOnStep(task, a),
            ),
      ],
    ];

    final side = <Widget>[
      if (actions.contains(GraphAction.start))
        _sideButton(ProButton.text(_word(GraphAction.start), tone: ProTone.primary, onPressed: () => _act(GraphAction.start))),
      if (graph.state == GraphState.paused)
        _sideButton(ProButton.text(_word(GraphAction.resume), tone: ProTone.primary, onPressed: () => _act(GraphAction.resume))),
      if (graph.state == GraphState.ripe)
        _sideButton(ProButton.text('看改动，${_word(GraphAction.merge)}…', tone: ProTone.primary, onPressed: () => setState(() => _reviewing = true))),
      if (actions.contains(GraphAction.pause)) _sideButton(ProButton.text(_word(GraphAction.pause), onPressed: () => _act(GraphAction.pause))),
      if (actions.contains(GraphAction.abandon)) _sideButton(ProButton.text('${_word(GraphAction.abandon)}…', tone: ProTone.quiet, onPressed: _abandon)),
      const SizedBox(height: 8),
      ProProperty('状态', Text(graph.stateTag ?? graph.state.wire)),
      ProProperty('项目', TextLink(graph.project, onTap: () => context.go('/projects/${Uri.encodeComponent(graph.project)}'))),
      ProProperty('进度', Text('$settled / $total 步')),
      if (graph.spent case final spent?) ProProperty('花了', Text(spentText(spent))),
      const SizedBox(height: 4),
      ProMore(
        children: [
          if (graph.branch case final branch?) ProProperty('分支', Text(branch, style: ProText.mono)),
          ProProperty('同时做', Text('至多 ${graph.parallel.round()} 步')),
          ProProperty('写于', Text(wallClockText(graph.createdAt))),
          if (graph.note case final note? when note.isNotEmpty) ProProperty('备注', Text(note)),
        ],
      ),
      const SizedBox(height: 12),
      DefaultTextStyle(
        style: ProText.meta,
        child: InlineLink('在农场的计划板上加步骤、改步骤', onTap: _toFarmBoard),
      ),
    ];
    return IssueSheet(heading: heading, main: main, side: side);
  }

  Widget _sideButton(Widget button) => Padding(padding: const EdgeInsets.only(bottom: 8), child: button);
}

class _Progress extends StatelessWidget {
  const _Progress({required this.settled, required this.total, required this.line});
  final int settled;
  final int total;
  final String line;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    mainAxisSize: MainAxisSize.min,
    children: [
      Row(
        children: [
          Text('做完 $settled / $total 步', style: ProText.sm.copyWith(fontWeight: FontWeight.w600)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(line, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.meta),
          ),
        ],
      ),
      const SizedBox(height: 8),
      ClipRRect(
        borderRadius: const BorderRadius.all(Radius.circular(3)),
        child: SizedBox(
          height: 6,
          child: Stack(
            fit: StackFit.expand,
            children: [
              const ColoredBox(color: ProColor.hover),
              FractionallySizedBox(
                alignment: Alignment.centerLeft,
                widthFactor: total == 0 ? 0 : (settled / total).clamp(0, 1),
                child: const ColoredBox(color: Palette.leaf500),
              ),
            ],
          ),
        ),
      ),
    ],
  );
}

class _Note extends StatelessWidget {
  const _Note(this.text, this.tone);
  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(color: tone.withValues(alpha: .16), borderRadius: const BorderRadius.all(Radius.circular(8))),
    child: Text(text, style: ProText.sm),
  );
}

Color _stepColor(TaskState s) => switch (s) {
  TaskState.waiting => ProColor.faint,
  TaskState.working => Palette.water,
  TaskState.merged => Palette.leaf500,
  TaskState.failed => Palette.berry,
  TaskState.skipped => ProColor.line,
};

/// One step, folded to its state and what it waits on; opened, what it is to do and what can be done with it.
class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.task,
    required this.graph,
    required this.agent,
    required this.waitsOn,
    required this.issue,
    required this.last,
    required this.onOpen,
    required this.onAct,
  });
  final Task task;
  final TaskGraph graph;
  final String? agent;
  final List<String> waitsOn;
  final String? issue;
  final bool last;
  final ValueChanged<String?> onOpen;
  final ValueChanged<TaskAction> onAct;

  @override
  Widget build(BuildContext context) {
    final state = task.stateText ?? task.state.wire;
    final summary = [state, ?agent, if (task.state == TaskState.waiting && waitsOn.isNotEmpty) '等「${waitsOn.join('」「')}」'].join(' · ');
    return ProFold(
      label: task.title,
      summary: summary,
      last: last,
      leading: task.state == TaskState.merged ? const SpriteIcon('mark-check', size: 12) : ProDot(_stepColor(task.state), size: 9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (task.brief.isNotEmpty) ProMarkdown(task.brief),
          if (task.check case final check? when check.isNotEmpty) ...[const SizedBox(height: 8), ProProperty('检查', Text(check, style: ProText.mono))],
          if (task.scope?.isNotEmpty ?? false) ProProperty('改哪里', Text(task.scope!.join('、'), style: ProText.mono)),
          if (task.conclusion case final c? when c.isNotEmpty) ProProperty('结论', Text(c)),
          if (task.spent case final spent?) ProProperty('花了', Text(spentText(spent))),
          if (task.tries > 1) ProProperty('试了', Text('${task.tries.round()} 次')),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (issue != null) ProButton.text('打开这张工单', icon: 'button-open', size: ProSize.sm, onPressed: () => onOpen(issue)),
              for (final a in task.actions ?? const <TaskAction>[])
                ProButton.text(task.actionText?[a.wire] ?? a.wire, size: ProSize.sm, onPressed: () => onAct(a)),
            ],
          ),
        ],
      ),
    );
  }
}

/// A ripe plan's changes before they go into the main branch: its commits and files, and the merge.
class _PlanHarvest extends ConsumerWidget {
  const _PlanHarvest({required this.graph, required this.onDone});
  final TaskGraph graph;
  final void Function(Answer? answer) onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) => ProPanel(
    child: switch (ref.watch(graphChangesProvider(graph.id))) {
      AsyncData(value: final changes) => Builder(
        builder: (context) {
          final (added, removed) = lineCounts(changes);
          final conflicts = changes.conflicts.toSet();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 8,
                children: [
                  Text(
                    '${changes.branch ?? ''} → ${changes.base}：${changes.commits.length} 个提交，${changes.files.length} 个文件',
                    style: ProText.sm.copyWith(fontWeight: FontWeight.w600),
                  ),
                  PlusMinus(added, removed),
                  if (changes.behind > 0) Text('这期间 ${changes.base} 多了 ${changes.behind.round()} 个提交', style: ProText.meta),
                ],
              ),
              if (conflicts.isNotEmpty) ...[
                const SizedBox(height: 8),
                _Note('合进 ${changes.base} 会冲突：${changes.conflicts.join('、')}。先不收，等 ${changes.base} 上的改动处理好。', Palette.berry),
              ],
              const SheetLabel('提交', top: 12),
              for (final c in changes.commits)
                Row(
                  children: [
                    Text(c.hash, style: ProText.mono.copyWith(color: ProColor.muted)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(c.subject, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.sm),
                    ),
                  ],
                ),
              const SheetLabel('文件', top: 12),
              for (final f in changes.files)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: FileRow(file: f, conflict: conflicts.contains(f.path)),
                ),
              const SizedBox(height: 12),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  ProButton.text('先不收', onPressed: () => onDone(null)),
                  const SizedBox(width: 8),
                  ProButton.text(
                    '确认收获，合进 ${changes.base}',
                    tone: ProTone.primary,
                    onPressed: conflicts.isNotEmpty ? null : () async => onDone(await ref.read(farmCommandsProvider).actOnGraph(graph.id, GraphAction.merge)),
                  ),
                ],
              ),
            ],
          );
        },
      ),
      AsyncError(:final error) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('看不了改动：${reasonOf(error)}', style: ProText.sm.copyWith(color: Palette.berry)),
          const SizedBox(height: 8),
          ProButton.text('先不收', onPressed: () => onDone(null)),
        ],
      ),
      _ => Text('正在看计划分支改了什么…', style: ProText.sm.copyWith(color: ProColor.muted)),
    },
  );
}
