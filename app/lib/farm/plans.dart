// 种植计划 (web/src/farm/Plans.tsx): the plan board. Every playbook, its steps laid out in columns (each after the
// steps it needs), and what can be done: ask for a plan, look a draft over and change its steps, start, pause, go on,
// retry or skip a step, harvest the whole playbook, and read how each step got where it is.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../desk/shared/state.dart' show projectNamesProvider;
import '../game/commands.dart';
import '../game/farm.dart';
import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show agentsProvider;
import 'bits.dart';
import 'harvest.dart';
import '../rules/farm.dart';
import '../rules/index.dart';
import '../rules/playbook.dart';

const _cream = Palette.cream50;

/// A playbook's state in a word or two, for its tag.
const _stateTag = {
  PlaybookState.planning: ('在拆', Color(0xFFD5DCD7), Palette.bark800),
  PlaybookState.draft: ('等你看', Color(0xFFEFD08F), Palette.bark900),
  PlaybookState.running: ('在做', Palette.leaf500, _cream),
  PlaybookState.paused: ('暂停了', Palette.cream300, Palette.bark800),
  PlaybookState.ripe: ('可收获', Palette.wheat, Palette.bark900),
  PlaybookState.done: ('收完了', Palette.cream200, Palette.bark600),
  PlaybookState.abandoned: ('放弃了', Palette.cream200, Palette.bark500),
};

FarmTag _tagOf(PlaybookState s) => FarmTag(_stateTag[s]!.$1, fill: _stateTag[s]!.$2, ink: _stateTag[s]!.$3);

/// Each step's card and tag by its state.
({Color card, Color? edge, Color tag, Color ink, double opacity}) _nodeTone(NodeState s) => switch (s) {
  NodeState.waiting => (card: Palette.cream100, edge: null, tag: Palette.cream200, ink: _Ink.bark700, opacity: 1),
  NodeState.working => (card: tint(Palette.leaf300, .35), edge: Palette.leaf500, tag: Palette.leaf500, ink: _cream, opacity: 1),
  NodeState.merged => (card: tint(Palette.wheat, .2), edge: null, tag: tint(Palette.wheat, .6), ink: Palette.bark900, opacity: 1),
  NodeState.failed => (card: tint(Palette.berry, .1), edge: Palette.berry.withValues(alpha: .5), tag: Palette.berry, ink: _cream, opacity: 1),
  NodeState.skipped => (card: Palette.cream100, edge: null, tag: Palette.cream200, ink: Palette.bark600, opacity: .6),
};

/// The page's text-bark-700: no such colour is defined, so the text keeps the ink around it.
abstract final class _Ink {
  static const bark700 = Palette.bark900;
}

/// The plan board: the tabs of playbooks, newest first, and the one shown; a new plan's form when there is none.
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
                        _tagOf(p.state),
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

// ── Asking for a plan ────────────────────────────────────────────────────────

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
    final s = ref.watch(farmProvider);
    return {...real, for (final h in s?.helpers ?? const <Helper>[]) ?h.project, for (final p in ref.watch(plansProvider)) p.project}.toList();
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
    final agents = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{}).values.where((a) => a.enabled);
    final ok = !_busy && _goal.trim().isNotEmpty && project.trim().isNotEmpty;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('一件很长的活：先派一个帮工读代码，把它拆成几步，每步交给一个帮工，有先后。拆好了你看过、改过再开工；每步做完合进计划自己的分支，全做完你再一次收进主分支。', style: KitText.sm.copyWith(color: _Ink.bark700)),
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

// ── One playbook ─────────────────────────────────────────────────────────────

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

  /// The step whose history is shown; null: the whole playbook's.
  String? _only;

  Future<void> _act(PlaybookAction action) async {
    final a = await ref.read(farmCommandsProvider).actOnPlaybook(widget.pb.id, action);
    if (mounted) setState(() => _said = a);
  }

  @override
  Widget build(BuildContext context) {
    final pb = widget.pb;
    final settled = pb.nodes.where(isSettled).length;
    final spent = playbookSpent(pb);
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
                  _tagOf(pb.state),
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
                  FarmTag('项目 ${pb.project}', fill: const Color(0xFFA5743F), ink: _cream),
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
                      if (pb.state == PlaybookState.draft) ...[
                        PxButton.text('开工', tone: PxTone.primary, onPressed: () => _act(PlaybookAction.start)),
                        PxButton.text('加一步', icon: 'button-add', onPressed: () => setState(() => _adding = true)),
                      ],
                      if (pb.state == PlaybookState.running) PxButton.text('暂停', onPressed: () => _act(PlaybookAction.pause)),
                      if (pb.state == PlaybookState.paused) PxButton.text('继续', tone: PxTone.primary, onPressed: () => _act(PlaybookAction.resume)),
                      if (pb.state == PlaybookState.ripe) PxButton.text('看改动，收获…', tone: PxTone.primary, onPressed: () => setState(() => _reviewing = true)),
                      Confirm(label: '放弃这个计划', sure: '确定放弃？分支会留着', onConfirm: () => _act(PlaybookAction.abandon)),
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

/// A button that asks once more before it does something that cannot be taken back.
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

/// The steps in columns: each column after the ones before it.
class Graph extends StatefulWidget {
  const Graph({super.key, required this.pb, required this.adding, required this.onSaid, required this.onAdded, required this.onHistory});
  final Playbook pb;
  final bool adding;
  final ValueChanged<Answer> onSaid;
  final VoidCallback onAdded;
  final ValueChanged<String> onHistory;

  @override
  State<Graph> createState() => _GraphState();
}

class _GraphState extends State<Graph> {
  String? _editing;

  @override
  Widget build(BuildContext context) {
    final pb = widget.pb;
    if (pb.nodes.isEmpty) return const FarmEmpty('计划里还没有步骤。');
    final layers = layersOf(pb.nodes);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (i, ids) in layers.indexed) ...[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 32, 8, 0),
                child: ExcludeSemantics(
                  child: Text('→', style: KitText.lg.copyWith(color: Palette.bark400)),
                ),
              ),
            SizedBox(
              width: 240,
              child: Semantics(
                label: i == 0 ? '先做' : '第 ${i + 1} 批',
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Text(i == 0 ? '先做' : '第 ${i + 1} 批', style: KitText.xs.copyWith(color: Palette.bark500)),
                    ),
                    for (final id in ids)
                      if (pb.nodes.where((n) => n.id == id).firstOrNull case final node?)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: _editing == id
                              ? NodeEditor(
                                  pb: pb,
                                  node: node,
                                  onDone: (answer) {
                                    setState(() => _editing = null);
                                    if (answer != null) widget.onSaid(answer);
                                  },
                                )
                              : NodeCard(
                                  pb: pb,
                                  node: node,
                                  onEdit: () => setState(() => _editing = id),
                                  onSaid: widget.onSaid,
                                  onHistory: () => widget.onHistory(id),
                                ),
                        ),
                  ],
                ),
              ),
            ),
          ],
          if (widget.adding)
            Padding(
              padding: const EdgeInsets.only(left: 8),
              child: SizedBox(
                width: 256,
                child: NodeEditor(
                  pb: pb,
                  onDone: (answer) {
                    widget.onAdded();
                    if (answer != null) widget.onSaid(answer);
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class NodeCard extends ConsumerWidget {
  const NodeCard({super.key, required this.pb, required this.node, required this.onEdit, required this.onSaid, required this.onHistory});
  final Playbook pb;
  final PlaybookNode node;
  final VoidCallback onEdit;
  final ValueChanged<Answer> onSaid;
  final VoidCallback onHistory;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agent = node.agent == null ? null : (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{})[node.agent];
    final worker = node.helper == null ? null : ref.watch(farmProvider)?.helpers.where((h) => h.id == node.helper).firstOrNull;
    String titleOf(String id) => nodeOf(pb, id)?.title ?? id;
    final waits = node.state == NodeState.waiting ? blockedBy(pb, node) : const <String>[];
    final live = pb.state == PlaybookState.running || pb.state == PlaybookState.paused;
    final editable = pb.state == PlaybookState.draft || (live && (node.state == NodeState.waiting || node.state == NodeState.failed));
    final doing = worker == null ? null : doingOf(worker);
    final commands = ref.read(farmCommandsProvider);
    Future<void> nodeAct(NodeAction action) async => onSaid(await commands.actOnNode(pb.id, node.id, action));
    final tone = _nodeTone(node.state);
    final small = KitText.xs.copyWith(color: Palette.bark600);
    return Opacity(
      opacity: tone.opacity,
      child: Container(
        decoration: BoxDecoration(
          color: tone.card,
          border: tone.edge == null ? null : Border.all(color: tone.edge!, width: 1.5),
        ),
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Tooltip(
                    message: node.title,
                    child: Text(node.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.sm),
                  ),
                ),
                const SizedBox(width: 6),
                if (node.acceptance == true) ...[
                  Tooltip(
                    message: switch (node.frozen) {
                      final frozen? when frozen.isNotEmpty => '验收，冻结了：${frozen.join('、')}',
                      _ => '验收：写好时要不通过，最后一步让它通过',
                    },
                    child: const FarmTag('验收', fill: Color(0xFF5C7A3A), ink: _cream),
                  ),
                  const SizedBox(width: 4),
                ],
                FarmTag(nodeStateText[node.state]!, fill: tone.tag, ink: tone.ink),
              ],
            ),
            const SizedBox(height: 4),
            Tooltip(
              message: node.task,
              child: Text(
                node.task,
                maxLines: 4,
                overflow: TextOverflow.ellipsis,
                style: KitText.xs.copyWith(color: Palette.bark800),
              ),
            ),
            const SizedBox(height: 6),
            Row(
              children: [
                if (agent != null) ...[AgentFace(agent.id, size: 18), const SizedBox(width: 4)],
                Text(agent?.name ?? '按规则挑', style: small),
                if (node.check case final check? when check.isNotEmpty) ...[
                  const Spacer(),
                  Flexible(
                    child: Tooltip(
                      message: '做完跑 $check',
                      child: Container(
                        color: _cream.withValues(alpha: .8),
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text(
                          check,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: KitText.mono.copyWith(fontSize: 10, color: _Ink.bark700),
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
            if (node.needs.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(waits.isNotEmpty ? '等 ${waits.map(titleOf).join('、')}' : '接在 ${node.needs.map(titleOf).join('、')} 后面', style: small),
              ),
            if (worker != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Container(
                  color: _cream.withValues(alpha: .7),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                  child: Text(
                    '${worker.name} · 第 ${stationOfHelper(worker) + 1} 块地${doing != null && doing.action != WorkerAction.none ? ' · 在${actionMeaning[doing.action]}' : ''}',
                    style: KitText.xs.copyWith(color: Palette.bark800),
                  ),
                ),
              ),
            if (node.conclusion case final c? when c.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Tooltip(
                  message: c,
                  child: Text(
                    c,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: KitText.xs.copyWith(color: node.state == NodeState.failed ? Palette.berry : Palette.bark800),
                  ),
                ),
              ),
            if ((node.commits ?? const []).isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  node.commits!.join(' '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: KitText.mono.copyWith(fontSize: 10, color: Palette.bark500),
                ),
              ),
            if (node.spent != null) Text(spentText(node.spent!), style: KitText.xs.copyWith(fontSize: 10, color: Palette.bark500)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                if (live && node.state == NodeState.failed) SmallBtn('重试', onTap: () => nodeAct(NodeAction.retry)),
                if (live && (node.state == NodeState.failed || node.state == NodeState.waiting)) SmallBtn('跳过', onTap: () => nodeAct(NodeAction.skip)),
                if (editable) SmallBtn('改', onTap: onEdit),
                if (pb.state == PlaybookState.draft) SmallBtn('删', onTap: () async => onSaid(await commands.removeNode(pb.id, node.id))),
                SmallBtn('经过', onTap: onHistory),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// A small cream button (Plans.tsx SmallBtn).
class SmallBtn extends StatelessWidget {
  const SmallBtn(this.label, {super.key, required this.onTap, this.primary = false});
  final String label;
  final VoidCallback? onTap;
  final bool primary;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    builder: (context, s) => Opacity(
      opacity: s.enabled ? 1 : .4,
      child: Container(
        color: primary ? (s.hovered ? Palette.leaf600 : Palette.leaf500) : (s.hovered ? Palette.cream200 : _cream),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
        child: Text(label, style: KitText.xs.copyWith(color: primary ? _cream : Palette.bark800)),
      ),
    ),
  );
}

const _actorTone = {
  PlaybookActor.user: (Palette.leaf500, _cream),
  PlaybookActor.foreman: (Color(0xFFEFD08F), Palette.bark900),
  PlaybookActor.farm: (Palette.cream200, _Ink.bark700),
};

String _when(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// What happened to the playbook, newest first: who did what, each step's way from start to merge.
class PlanLog extends ConsumerStatefulWidget {
  const PlanLog({super.key, required this.pb, required this.only, required this.onAll});
  final Playbook pb;
  final String? only;
  final VoidCallback onAll;

  @override
  ConsumerState<PlanLog> createState() => _PlanLogState();
}

class _PlanLogState extends ConsumerState<PlanLog> {
  @override
  void initState() {
    super.initState();
    _load();
  }

  // Loaded when shown, and again whenever the playbook changes: something happened.
  @override
  void didUpdateWidget(PlanLog old) {
    super.didUpdateWidget(old);
    if (old.pb != widget.pb) _load();
  }

  void _load() => ref.read(playbookLogProvider.notifier).load(widget.pb.id).catchError((Object _) {});

  @override
  Widget build(BuildContext context) {
    final pb = widget.pb;
    final events = ref.watch(playbookLogProvider.select((all) => all[pb.id]));
    String titleOf(String id) => nodeOf(pb, id)?.title ?? id;
    final only = widget.only;
    final shown = (events ?? const <PlaybookEvent>[]).where((e) => only == null || e.node == only).toList().reversed.toList();
    return FarmSection(
      title: only == null ? '经过' : '「${titleOf(only)}」的经过',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (only != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: KitTappable(
                onTap: widget.onAll,
                builder: (context, s) => Container(
                  color: s.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                  child: Text('看整个计划的经过', style: KitText.xs.copyWith(color: Palette.bark800)),
                ),
              ),
            ),
          if (shown.isEmpty)
            Text(events != null ? '还没有记下什么。' : '正在读…', style: KitText.sm.copyWith(color: Palette.bark600))
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 288),
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(right: 4),
                children: [
                  for (final e in shown)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: PlanLogRow(e: e, titleOf: titleOf),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class PlanLogRow extends StatefulWidget {
  const PlanLogRow({super.key, required this.e, required this.titleOf});
  final PlaybookEvent e;
  final String Function(String) titleOf;

  @override
  State<PlanLogRow> createState() => _PlanLogRowState();
}

class _PlanLogRowState extends State<PlanLogRow> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final e = widget.e;
    final (fill, ink) = _actorTone[e.actor]!;
    final changes = e.changes ?? const <NodeFieldChange>[];
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 88,
          child: Text(_when(e.at), style: KitText.xs.copyWith(color: Palette.bark400)),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 44,
          child: Container(
            color: fill,
            padding: const EdgeInsets.symmetric(vertical: 2),
            alignment: Alignment.center,
            child: Text(actorText[e.actor]!, style: KitText.xs.copyWith(fontSize: 10, color: ink)),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(playbookEventText(e, widget.titleOf), style: KitText.xs.copyWith(color: Palette.bark800)),
              if (changes.isNotEmpty) ...[
                KitTappable(
                  onTap: () => setState(() => _open = !_open),
                  builder: (context, s) => Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text('改前改后', style: KitText.xs.copyWith(color: Palette.bark600)),
                  ),
                ),
                if (_open)
                  for (final c in changes)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(c.field, style: KitText.xs.copyWith(color: Palette.bark600)),
                          Text.rich(
                            TextSpan(
                              children: [
                                TextSpan(
                                  text: c.from.isEmpty ? '（空）' : c.from,
                                  style: const TextStyle(color: Palette.berry, decoration: TextDecoration.lineThrough),
                                ),
                                const TextSpan(text: ' → '),
                                TextSpan(
                                  text: c.to.isEmpty ? '（空）' : c.to,
                                  style: const TextStyle(color: Palette.leaf700),
                                ),
                              ],
                            ),
                            style: KitText.xs.copyWith(color: Palette.bark600),
                          ),
                        ],
                      ),
                    ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// A step's job, title, who does it, what it waits for, and how it is checked; a new step when `node` is missing.
class NodeEditor extends ConsumerStatefulWidget {
  const NodeEditor({super.key, required this.pb, this.node, required this.onDone});
  final Playbook pb;
  final PlaybookNode? node;
  final void Function(Answer? answer) onDone;

  @override
  ConsumerState<NodeEditor> createState() => _NodeEditorState();
}

class _NodeEditorState extends ConsumerState<NodeEditor> {
  late var _id = widget.node?.id ?? '';
  late var _title = widget.node?.title ?? '';
  late var _task = widget.node?.task ?? '';
  late var _agent = widget.node?.agent ?? '';
  late var _check = widget.node?.check ?? '';
  late var _needs = [...?widget.node?.needs];
  var _problem = '';

  Future<void> _save() async {
    if (_id.trim().isEmpty || _task.trim().isEmpty) return;
    final answer = await ref
        .read(farmCommandsProvider)
        .editNode(widget.pb.id, _id.trim(), NodeEdit(title: _title, task: _task, agent: _agent, check: _check, needs: _needs));
    if (!mounted) return;
    if (answer.ok) {
      widget.onDone(answer);
    } else {
      setState(() => _problem = answer.text);
    }
  }

  @override
  Widget build(BuildContext context) {
    final agents = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{}).values.where((a) => a.enabled);
    final others = widget.pb.nodes.where((n) => n.id != (widget.node?.id ?? _id)).toList();
    final ready = _id.trim().isNotEmpty && _task.trim().isNotEmpty;
    return Container(
      decoration: BoxDecoration(
        color: Palette.cream100,
        border: Border.all(color: Palette.leaf500, width: 1.5),
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.node == null) ...[
            PxTextInput(value: _id, onChanged: (v) => setState(() => _id = v), placeholder: '步骤 id，比如 docs', semanticLabel: '步骤 id', mono: true),
            const SizedBox(height: 6),
          ],
          PxTextInput(value: _title, onChanged: (v) => setState(() => _title = v), placeholder: '标题', semanticLabel: '标题'),
          const SizedBox(height: 6),
          PxTextArea(value: _task, onChanged: (v) => setState(() => _task = v), rows: 5, placeholder: '工单：目标、改哪里、做到什么程度算完', semanticLabel: '工单'),
          const SizedBox(height: 6),
          PxPick(
            value: _agent,
            placeholder: '谁来做：按规则挑',
            semanticLabel: '谁来做',
            onChanged: (v) => setState(() => _agent = v),
            options: [
              const PickOption(value: '', label: '谁来做：按规则挑'),
              for (final a in agents) PickOption(value: a.id, label: a.name),
            ],
          ),
          const SizedBox(height: 6),
          PxTextInput(value: _check, onChanged: (v) => setState(() => _check = v), placeholder: '做完跑的检查，比如 pnpm test（可空）', semanticLabel: '检查命令', mono: true),
          if (others.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text('等这些做完：', style: KitText.xs.copyWith(color: Palette.bark600)),
            const SizedBox(height: 2),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (final n in others)
                  KitTappable(
                    onTap: () => setState(() => _needs = _needs.contains(n.id) ? (_needs..remove(n.id)) : [..._needs, n.id]),
                    selected: _needs.contains(n.id),
                    builder: (context, s) {
                      final on = _needs.contains(n.id);
                      return Container(
                        color: on ? Palette.leaf500 : (s.hovered ? Palette.cream200 : _cream),
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        child: Text(n.title, style: KitText.xs.copyWith(color: on ? _cream : Palette.bark800)),
                      );
                    },
                  ),
              ],
            ),
          ],
          if (_problem.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(_problem, style: KitText.xs.copyWith(color: Palette.berry)),
            ),
          const SizedBox(height: 4),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              SmallBtn('算了', onTap: () => widget.onDone(null)),
              const SizedBox(width: 4),
              SmallBtn(widget.node != null ? '改好了' : '加上', primary: true, onTap: ready ? _save : null),
            ],
          ),
        ],
      ),
    );
  }
}

// ── Harvesting the whole playbook ────────────────────────────────────────────

/// What the playbook's branch would bring into the main branch, looked at before saying yes.
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
    final api = ref.read(farmApiProvider);
    loadChanges(() => api.playbookChanges(id: widget.pb.id)).then((l) {
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
                      : () async => widget.onDone(await ref.read(farmCommandsProvider).actOnPlaybook(widget.pb.id, PlaybookAction.harvest)),
                ),
              ],
            ),
          ],
        );
    }
  }
}
