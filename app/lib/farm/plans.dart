import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/ui_state.dart';
import '../data/remote.dart' show projectNamesProvider;
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import 'widgets.dart';
import '../shared/harvest.dart';
import '../rules/playbook.dart';
import '../shared/tags.dart';
import '../rules/money.dart';
import 'plan_board.dart';
import 'plan_log.dart';

const _stateTone = {
  PlaybookState.planning: (Color(0xFFD5DCD7), Palette.bark800),
  PlaybookState.draft: (Color(0xFFEFD08F), Palette.bark900),
  PlaybookState.running: (Palette.leaf500, Palette.cream50),
  PlaybookState.paused: (Palette.cream300, Palette.bark800),
  PlaybookState.ripe: (Palette.wheat, Palette.bark900),
  PlaybookState.done: (Palette.cream200, Palette.bark600),
  PlaybookState.abandoned: (Palette.cream200, Palette.bark500),
};

FarmTag _tagOf(Playbook p) => FarmTag(p.stateTag ?? '', fill: _stateTone[p.state]!.$1, ink: _stateTone[p.state]!.$2);

String _actionText(Playbook p, PlaybookAction a) => p.actionText?[a.wire] ?? '';

class Plans extends ConsumerStatefulWidget {
  const Plans({super.key});

  @override
  ConsumerState<Plans> createState() => _PlansState();
}

class _PlansState extends ConsumerState<Plans> {
  var _creating = false;

  @override
  Widget build(BuildContext context) {
    final all = ref.watch(plansProvider);
    final shown = ref.watch(planShownProvider);
    final list = all.reversed.toList();
    final current = list.where((p) => p.id == shown).firstOrNull ?? list.where(isOpen).firstOrNull ?? list.firstOrNull;
    if (_creating || current == null) {
      return NewPlan(
        onCancel: current != null ? () => setState(() => _creating = false) : null,
        onPlanned: (id) {
          setState(() => _creating = false);
          ref.read(planShownProvider.notifier).set(id);
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
                KitTappable(
                  onTap: () => ref.read(planShownProvider.notifier).set(p.id),
                  selected: p.id == current.id,
                  builder: (context, s) => Container(
                    constraints: const BoxConstraints(maxWidth: 224),
                    color: p.id == current.id ? tint(Palette.leaf300, .7) : (s.hovered ? Palette.cream300 : Palette.cream200),
                    padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(p.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.xs),
                        ),
                        const SizedBox(width: 6),
                        _tagOf(p),
                      ],
                    ),
                  ),
                ),
              KitTappable(
                onTap: () => setState(() => _creating = true),
                builder: (context, s) => Container(
                  color: s.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const SpriteIcon('button-add', size: 12),
                      const SizedBox(width: 4),
                      Text('新计划', style: KitText.xs.copyWith(color: Palette.leaf700)),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        PlanView(key: ValueKey(current.id), pb: current),
      ],
    );
  }
}

class NewPlan extends ConsumerStatefulWidget {
  const NewPlan({super.key, this.onCancel, required this.onPlanned});
  final VoidCallback? onCancel;
  final ValueChanged<String> onPlanned;

  @override
  ConsumerState<NewPlan> createState() => _NewPlanState();
}

class _NewPlanState extends ConsumerState<NewPlan> {
  var _goal = '';
  String? _project;
  var _planner = 'auto';
  Answer? _said;
  var _busy = false;

  List<String> _known() {
    final real = ref.watch(projectNamesProvider).value ?? const <String>[];
    final s = ref.watch(stateProvider);
    return {...real, for (final h in s?.sessions ?? const <Session>[]) ?h.project, for (final p in ref.watch(plansProvider)) p.project}.toList();
  }

  Future<void> _submit(String project) async {
    if (_goal.trim().isEmpty || project.trim().isEmpty) return;
    setState(() => _busy = true);
    final answer = await ref.read(farmCommandsProvider).plan(PlanRequest(goal: _goal, project: project, agent: _planner == 'auto' ? null : _planner));
    if (!mounted) return;
    setState(() => _busy = false);
    final id = RegExp(r'（(p\d+)）').firstMatch(answer.text)?[1];
    if (answer.ok && id != null) {
      widget.onPlanned(id);
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
        Text('一件很长的活：先派一个帮工读代码，把它拆成几步，每步交给一个帮工，有先后。拆好了你看过、改过再开工；每步做完合进计划自己的分支，全做完你再一次收进主分支。', style: KitText.sm.copyWith(color: Palette.bark900)),
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
                  value: _planner,
                  placeholder: '按规则挑',
                  onChanged: (v) => setState(() => _planner = v),
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

class PlanView extends ConsumerStatefulWidget {
  const PlanView({super.key, required this.pb});
  final Playbook pb;

  @override
  ConsumerState<PlanView> createState() => _PlanViewState();
}

class _PlanViewState extends ConsumerState<PlanView> {
  Answer? _said;
  var _reviewing = false;
  var _adding = false;

  /// null: the whole playbook's.
  String? _only;

  Future<void> _act(PlaybookAction action) async {
    final a = await ref.read(farmCommandsProvider).actOnPlaybook(widget.pb.id, action);
    if (mounted) setState(() => _said = a);
  }

  @override
  Widget build(BuildContext context) {
    final pb = widget.pb;
    final settled = pb.settled ?? 0;
    final spent = pb.spent;
    final xs = KitText.xs.copyWith(color: Palette.bark600);
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
                  Text(pb.title, style: KitText.sm),
                  _tagOf(pb),
                  if (pb.nodes.isNotEmpty) Text('$settled/${pb.nodes.length} 步', style: xs),
                  if (spent != null) Text('花了 ${spentText(spent)}', style: xs),
                ],
              ),
              const SizedBox(height: 4),
              Text(pb.goal, style: KitText.sm.copyWith(color: Palette.bark800)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  FarmTag('项目 ${pb.project}', fill: const Color(0xFFA5743F), ink: Palette.cream50),
                  if (pb.branch != null) FarmTag(pb.branch!),
                  if (pb.state == PlaybookState.running) Text('每步做完合进这条分支；收获时整条合进主分支', style: KitText.xs.copyWith(color: Palette.bark500)),
                ],
              ),
              if (pb.note != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Tinted(
                    color: tint(Palette.wheat, .25),
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    child: Text(pb.note!, style: KitText.xs),
                  ),
                ),
              if (isOpen(pb))
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (pb.actions?.contains(PlaybookAction.start) ?? false) ...[
                        PxButton.text(_actionText(pb, PlaybookAction.start), tone: PxTone.primary, onPressed: () => _act(PlaybookAction.start)),
                        PxButton.text('加一步', icon: 'button-add', onPressed: () => setState(() => _adding = true)),
                      ],
                      if (pb.actions?.contains(PlaybookAction.pause) ?? false)
                        PxButton.text(_actionText(pb, PlaybookAction.pause), onPressed: () => _act(PlaybookAction.pause)),
                      if (pb.state == PlaybookState.paused)
                        PxButton.text(_actionText(pb, PlaybookAction.resume), tone: PxTone.primary, onPressed: () => _act(PlaybookAction.resume)),
                      if (pb.state == PlaybookState.ripe)
                        PxButton.text(
                          '看改动，${_actionText(pb, PlaybookAction.merge)}…',
                          tone: PxTone.primary,
                          onPressed: () => setState(() => _reviewing = true),
                        ),
                      if (pb.actions?.contains(PlaybookAction.abandon) ?? false)
                        Confirm(label: '${_actionText(pb, PlaybookAction.abandon)}这个计划', sure: '确定放弃？分支会留着', onConfirm: () => _act(PlaybookAction.abandon)),
                    ],
                  ),
                ),
              Said(_said),
            ],
          ),
        ),
        const SizedBox(height: 12),
        if (_reviewing)
          PlanHarvest(
            pb: pb,
            onDone: (answer) => setState(() {
              _reviewing = false;
              if (answer != null) _said = answer;
            }),
          )
        else if (pb.state == PlaybookState.planning)
          const FarmEmpty('帮工在读代码、拆计划。拆好了会出现在这里，你看过再开工。')
        else
          Graph(
            pb: pb,
            adding: _adding,
            onSaid: (a) => setState(() => _said = a),
            onAdded: () => setState(() => _adding = false),
            onHistory: (node) => setState(() => _only = node),
          ),
        PlanLog(pb: pb, only: _only, onAll: () => setState(() => _only = null)),
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

class PlanHarvest extends ConsumerStatefulWidget {
  const PlanHarvest({super.key, required this.pb, required this.onDone});
  final Playbook pb;
  final void Function(Answer? answer) onDone;

  @override
  ConsumerState<PlanHarvest> createState() => _PlanHarvestState();
}

class _PlanHarvestState extends ConsumerState<PlanHarvest> {
  Loaded _loaded = const Loading();

  @override
  void initState() {
    super.initState();
    final api = ref.read(apiProvider);
    loadChanges(() => api.playbook.changes(id: widget.pb.id)).then((l) {
      if (mounted) setState(() => _loaded = l);
    });
  }

  @override
  Widget build(BuildContext context) {
    switch (_loaded) {
      case Loading():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 40),
          child: Text(
            '正在看计划分支改了什么…',
            textAlign: TextAlign.center,
            style: KitText.sm.copyWith(color: Palette.bark600),
          ),
        );
      case LoadFailed(:final reason):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Tinted(
              color: tint(Palette.berry, .12),
              child: Text('看不了改动：$reason', style: KitText.sm.copyWith(color: Palette.berry)),
            ),
            const SizedBox(height: 12),
            PxButton.text('先不收', onPressed: () => widget.onDone(null)),
          ],
        );
      case LoadReady(:final changes):
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
              style: KitText.sm,
            ),
            if (conflicts.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Tinted(
                  color: tint(Palette.berry, .12),
                  child: Text(
                    '合进 ${changes.base} 会冲突：${changes.conflicts.join('、')}。先不收，等 ${changes.base} 上的改动处理好。',
                    style: KitText.sm.copyWith(color: Palette.berry),
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
                        Text(c.hash, style: KitText.mono.copyWith(color: Palette.bark500)),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            c.subject,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: KitText.xs.copyWith(color: Palette.bark800),
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
                PxButton.text('先不收', onPressed: () => widget.onDone(null)),
                const SizedBox(width: 8),
                PxButton.text(
                  '确认收获，合进 ${changes.base}',
                  tone: PxTone.primary,
                  onPressed: conflicts.isNotEmpty
                      ? null
                      : () async => widget.onDone(await ref.read(farmCommandsProvider).actOnPlaybook(widget.pb.id, PlaybookAction.merge)),
                ),
              ],
            ),
          ],
        );
    }
  }
}
