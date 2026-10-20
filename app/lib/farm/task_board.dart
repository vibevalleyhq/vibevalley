import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/ui_state.dart';
import '../data/remote.dart' show projectNamesProvider, graphChangesProvider, reasonOf;
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../ui/pixel/pixel.dart';
import '../data/remote.dart' show agentsProvider;
import 'widgets.dart';
import '../shared/harvest.dart';
import '../rules/task.dart';
import '../shared/tags.dart';
import '../rules/money.dart';
import 'task_steps.dart';
import 'task_log.dart';

const _stateTone = {
  GraphState.splitting: (Color(0xFFD5DCD7), Palette.bark800),
  GraphState.draft: (Color(0xFFEFD08F), Palette.bark900),
  GraphState.running: (Palette.leaf500, Palette.cream50),
  GraphState.paused: (Palette.cream300, Palette.bark800),
  GraphState.ripe: (Palette.wheat, Palette.bark900),
  GraphState.done: (Palette.cream200, Palette.bark600),
  GraphState.abandoned: (Palette.cream200, Palette.bark500),
};

FarmTag _tagOf(TaskGraph p) => FarmTag(p.stateTag ?? '', fill: _stateTone[p.state]!.$1, ink: _stateTone[p.state]!.$2);

String _actionText(TaskGraph p, GraphAction a) => p.actionText?[a.wire] ?? '';

class TaskBoard extends ConsumerStatefulWidget {
  const TaskBoard({super.key});

  @override
  ConsumerState<TaskBoard> createState() => _TaskBoardState();
}

class _TaskBoardState extends ConsumerState<TaskBoard> {
  var _creating = false;

  @override
  Widget build(BuildContext context) {
    final all = ref.watch(graphsProvider);
    final shown = ref.watch(graphShownProvider);
    final list = all.reversed.toList();
    final current = list.where((p) => p.id == shown).firstOrNull ?? list.where(isOpen).firstOrNull ?? list.firstOrNull;
    if (_creating || current == null) {
      return NewTask(
        onCancel: current != null ? () => setState(() => _creating = false) : null,
        onSplit: (id) {
          setState(() => _creating = false);
          ref.read(graphShownProvider.notifier).set(id);
        },
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          label: '种植计划',
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              for (final p in list)
                Tappable(
                  onTap: () => ref.read(graphShownProvider.notifier).set(p.id),
                  selected: p.id == current.id,
                  builder: (context, s) => Container(
                    constraints: const BoxConstraints(maxWidth: 224),
                    color: p.id == current.id ? tint(Palette.leaf300, .7) : (s.hovered ? Palette.cream300 : Palette.cream200),
                    padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(p.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: PxText.xs),
                        ),
                        const SizedBox(width: 6),
                        _tagOf(p),
                      ],
                    ),
                  ),
                ),
              Tappable(
                onTap: () => setState(() => _creating = true),
                builder: (context, s) => Container(
                  color: s.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const SpriteIcon('button-add', size: 12),
                      const SizedBox(width: 4),
                      Text('新计划', style: PxText.xs.copyWith(color: Palette.leaf700)),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        TaskView(key: ValueKey(current.id), graph: current),
      ],
    );
  }
}

class NewTask extends ConsumerStatefulWidget {
  const NewTask({super.key, this.onCancel, required this.onSplit});
  final VoidCallback? onCancel;
  final ValueChanged<String> onSplit;

  @override
  ConsumerState<NewTask> createState() => _NewTaskState();
}

class _NewTaskState extends ConsumerState<NewTask> {
  var _goal = '';
  String? _project;
  var _splitter = 'auto';
  Answer? _said;
  var _busy = false;

  List<String> _known() {
    final real = ref.watch(projectNamesProvider).value ?? const <String>[];
    final s = ref.watch(stateProvider);
    return {...real, for (final h in s?.sessions ?? const <Session>[]) ?h.project, for (final p in ref.watch(graphsProvider)) p.project}.toList();
  }

  Future<void> _submit(String project) async {
    if (_goal.trim().isEmpty || project.trim().isEmpty) return;
    setState(() => _busy = true);
    final answer = await ref.read(farmCommandsProvider).split(GraphSplitRequest(goal: _goal, project: project, agent: _splitter == 'auto' ? null : _splitter));
    if (!mounted) return;
    setState(() => _busy = false);
    final id = RegExp(r'（(p\d+)）').firstMatch(answer.text)?[1];
    if (answer.ok && id != null) {
      widget.onSplit(id);
    } else {
      setState(() => _said = answer);
    }
  }

  @override
  Widget build(BuildContext context) {
    final known = _known();
    final project = _project ?? known.firstOrNull ?? '';
    final agents = (ref.watch(agentsProvider).value ?? const <String, Agent>{}).values.where((a) => a.enabled);
    final ok = !_busy && _goal.trim().isNotEmpty && project.trim().isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('一件很长的活：先派一个帮工读代码，把它拆成几步，每步交给一个帮工，有先后。拆好了你看过、改过再开工；每步做完合进计划自己的分支，全做完你再一次收进主分支。', style: PxText.sm.copyWith(color: Palette.bark900)),
        const SizedBox(height: 12),
        PxField(
          label: '要做什么',
          child: PxTextArea(value: _goal, onChanged: (v) => setState(() => _goal = v), rows: 4, placeholder: '比如：给 clock-in 加按月查询打卡记录，带一个页面，要有测试'),
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: PxField(
                label: '在哪个项目',
                child: PxTextInput(value: project, onChanged: (v) => setState(() => _project = v), placeholder: 'clock-in', suggestions: known),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: PxField(
                label: '谁来拆',
                child: PxPick(
                  value: _splitter,
                  placeholder: '按规则挑',
                  onChanged: (v) => setState(() => _splitter = v),
                  options: [
                    const PickOption(value: 'auto', label: '按规则挑'),
                    for (final a in agents) PickOption(value: a.id, label: a.name),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (widget.onCancel != null) ...[PxButton.text('算了', onPressed: widget.onCancel), const SizedBox(width: 8)],
            PxButton.text('拆计划', tone: PxTone.primary, onPressed: ok ? () => _submit(project) : null),
          ],
        ),
        Said(_said),
      ],
    );
  }
}

class TaskView extends ConsumerStatefulWidget {
  const TaskView({super.key, required this.graph});
  final TaskGraph graph;

  @override
  ConsumerState<TaskView> createState() => _TaskViewState();
}

class _TaskViewState extends ConsumerState<TaskView> {
  Answer? _said;
  var _reviewing = false;
  var _adding = false;

  /// null: the whole task's.
  String? _only;

  Future<void> _act(GraphAction action) async {
    final a = await ref.read(farmCommandsProvider).actOnGraph(widget.graph.id, action);
    if (mounted) setState(() => _said = a);
  }

  @override
  Widget build(BuildContext context) {
    final graph = widget.graph;
    final settled = graph.settled ?? 0;
    final spent = graph.spent;
    final xs = PxText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Tinted(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(graph.title, style: PxText.sm),
                  _tagOf(graph),
                  if (graph.tasks.isNotEmpty) Text('$settled/${graph.tasks.length} 步', style: xs),
                  if (spent != null) Text('花了 ${spentText(spent)}', style: xs),
                ],
              ),
              const SizedBox(height: 4),
              Text(graph.goal, style: PxText.sm.copyWith(color: Palette.bark800)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  FarmTag('项目 ${graph.project}', fill: const Color(0xFFA5743F), ink: Palette.cream50),
                  if (graph.branch != null) FarmTag(graph.branch!),
                  if (graph.state == GraphState.running) Text('每步做完合进这条分支；收获时整条合进主分支', style: PxText.xs.copyWith(color: Palette.bark500)),
                ],
              ),
              if (graph.note != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Tinted(
                    color: tint(Palette.wheat, .25),
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    child: Text(graph.note!, style: PxText.xs),
                  ),
                ),
              if (isOpen(graph))
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (graph.actions?.contains(GraphAction.start) ?? false) ...[
                        PxButton.text(_actionText(graph, GraphAction.start), tone: PxTone.primary, onPressed: () => _act(GraphAction.start)),
                        PxButton.text('加一步', icon: 'button-add', onPressed: () => setState(() => _adding = true)),
                      ],
                      if (graph.actions?.contains(GraphAction.pause) ?? false)
                        PxButton.text(_actionText(graph, GraphAction.pause), onPressed: () => _act(GraphAction.pause)),
                      if (graph.state == GraphState.paused)
                        PxButton.text(_actionText(graph, GraphAction.resume), tone: PxTone.primary, onPressed: () => _act(GraphAction.resume)),
                      if (graph.state == GraphState.ripe)
                        PxButton.text(
                          '看改动，${_actionText(graph, GraphAction.merge)}…',
                          tone: PxTone.primary,
                          onPressed: () => setState(() => _reviewing = true),
                        ),
                      if (graph.actions?.contains(GraphAction.abandon) ?? false)
                        Confirm(label: '${_actionText(graph, GraphAction.abandon)}这个计划', sure: '确定放弃？分支会留着', onConfirm: () => _act(GraphAction.abandon)),
                    ],
                  ),
                ),
              Said(_said),
            ],
          ),
        ),
        const SizedBox(height: 12),
        if (_reviewing)
          TaskHarvest(
            graph: graph,
            onDone: (answer) => setState(() {
              _reviewing = false;
              if (answer != null) _said = answer;
            }),
          )
        else if (graph.state == GraphState.splitting)
          const FarmEmpty('帮工在读代码、拆计划。拆好了会出现在这里，你看过再开工。')
        else
          Graph(
            graph: graph,
            adding: _adding,
            onSaid: (a) => setState(() => _said = a),
            onAdded: () => setState(() => _adding = false),
            onHistory: (node) => setState(() => _only = node),
          ),
        TaskLog(graph: graph, only: _only, onAll: () => setState(() => _only = null)),
      ],
    );
  }
}

class Confirm extends StatefulWidget {
  const Confirm({super.key, required this.label, required this.sure, required this.onConfirm});
  final String label;
  final String sure;
  final VoidCallback onConfirm;

  @override
  State<Confirm> createState() => _ConfirmState();
}

class _ConfirmState extends State<Confirm> {
  var _asking = false;

  @override
  Widget build(BuildContext context) => _asking
      ? Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            PxButton.text(widget.sure, tone: PxTone.danger, onPressed: widget.onConfirm),
            const SizedBox(width: 6),
            PxButton.text('不了', onPressed: () => setState(() => _asking = false)),
          ],
        )
      : PxButton.text(widget.label, onPressed: () => setState(() => _asking = true));
}

class TaskHarvest extends ConsumerWidget {
  const TaskHarvest({super.key, required this.graph, required this.onDone});
  final TaskGraph graph;
  final void Function(Answer? answer) onDone;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    switch (ref.watch(graphChangesProvider(graph.id))) {
      case AsyncLoading():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 40),
          child: Text(
            '正在看计划分支改了什么…',
            textAlign: TextAlign.center,
            style: PxText.sm.copyWith(color: Palette.bark600),
          ),
        );
      case AsyncError(:final error):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Tinted(
              color: tint(Palette.berry, .12),
              child: Text('看不了改动：${reasonOf(error)}', style: PxText.sm.copyWith(color: Palette.berry)),
            ),
            const SizedBox(height: 12),
            PxButton.text('先不收', onPressed: () => onDone(null)),
          ],
        );
      case AsyncData(value: final changes):
        final (added, removed) = lineCounts(changes);
        final conflicts = changes.conflicts.toSet();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text.rich(
              TextSpan(
                children: [
                  TextSpan(text: '${changes.branch ?? ''} → ${changes.project} 的 ${changes.base}：${changes.commits.length} 个提交，${changes.files.length} 个文件，'),
                  TextSpan(
                    text: '+$added',
                    style: const TextStyle(color: Palette.leaf700),
                  ),
                  // The pixel font has no − (U+2212).
                  TextSpan(
                    text: ' -$removed',
                    style: const TextStyle(color: Palette.berry),
                  ),
                  if (changes.behind > 0)
                    TextSpan(
                      text: '；这期间 ${changes.base} 多了 ${changes.behind.round()} 个提交',
                      style: const TextStyle(color: Palette.bark600),
                    ),
                ],
              ),
              style: PxText.sm,
            ),
            if (conflicts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Tinted(
                  color: tint(Palette.berry, .12),
                  child: Text(
                    '合进 ${changes.base} 会冲突：${changes.conflicts.join('、')}。先不收，等 ${changes.base} 上的改动处理好。',
                    style: PxText.sm.copyWith(color: Palette.berry),
                  ),
                ),
              ),
            FarmSection(
              title: '提交',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final c in changes.commits)
                    Row(
                      children: [
                        Text(c.hash, style: PxText.mono.copyWith(color: Palette.bark500)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            c.subject,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: PxText.xs.copyWith(color: Palette.bark800),
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ),
            FarmSection(
              title: '文件',
              child: Column(
                children: [
                  for (final f in changes.files)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: FileRow(file: f, conflict: conflicts.contains(f.path)),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                PxButton.text('先不收', onPressed: () => onDone(null)),
                const SizedBox(width: 8),
                PxButton.text(
                  '确认收获，合进 ${changes.base}',
                  tone: PxTone.primary,
                  onPressed: conflicts.isNotEmpty ? null : () async => onDone(await ref.read(farmCommandsProvider).actOnGraph(graph.id, GraphAction.merge)),
                ),
              ],
            ),
          ],
        );
    }
  }
}
