import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../game/commands.dart';
import '../game/farm.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import 'bits.dart';
import '../rules/farm.dart';
import '../rules/playbook.dart';
import '../shared/faces.dart';
import '../shared/tags.dart';
import '../rules/money.dart';

({Color card, Color? edge, Color tag, Color ink, double opacity}) _nodeTone(NodeState s) => switch (s) {
  NodeState.waiting => (card: Palette.cream100, edge: null, tag: Palette.cream200, ink: Palette.bark900, opacity: 1),
  NodeState.working => (card: tint(Palette.leaf300, .35), edge: Palette.leaf500, tag: Palette.leaf500, ink: Palette.cream50, opacity: 1),
  NodeState.merged => (card: tint(Palette.wheat, .2), edge: null, tag: tint(Palette.wheat, .6), ink: Palette.bark900, opacity: 1),
  NodeState.failed => (card: tint(Palette.berry, .1), edge: Palette.berry.withValues(alpha: .5), tag: Palette.berry, ink: Palette.cream50, opacity: 1),
  NodeState.skipped => (card: Palette.cream100, edge: null, tag: Palette.cream200, ink: Palette.bark600, opacity: .6),
};

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
    final layers = pb.layers ?? const <List<String>>[];
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
    final agent = node.agent == null ? null : (ref.watch(agentsProvider).value ?? const <String, Agent>{})[node.agent];
    final session = node.session == null ? null : ref.watch(stateProvider)?.sessions.where((h) => h.id == node.session).firstOrNull;
    String titleOf(String id) => nodeOf(pb, id)?.title ?? id;
    final waits = node.state == NodeState.waiting ? node.blockedBy ?? const <String>[] : const <String>[];
    final live = pb.state == PlaybookState.running || pb.state == PlaybookState.paused;
    final editable = pb.state == PlaybookState.draft || (live && (node.state == NodeState.waiting || node.state == NodeState.failed));
    final doing = session == null ? null : doingOf(session);
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
                    child: const FarmTag('验收', fill: Color(0xFF5C7A3A), ink: Palette.cream50),
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
                if (agent != null) ...[AgentFaceOf(agent.id, size: 18), const SizedBox(width: 4)],
                Text(agent?.name ?? '按规则挑', style: small),
                if (node.check case final check? when check.isNotEmpty) ...[
                  const Spacer(),
                  Flexible(
                    child: Tooltip(
                      message: '做完跑 $check',
                      child: Container(
                        color: Palette.cream50.withValues(alpha: .8),
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        child: Text(
                          check,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: KitText.mono.copyWith(fontSize: 10, color: Palette.bark900),
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
            if (session != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Container(
                  color: Palette.cream50.withValues(alpha: .7),
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                  child: Text(
                    '${session.name} · 第 ${stationOfSession(session) + 1} 块地${doing != null && doing.action != SessionAction.none ? ' · 在${actionText[doing.action]}' : ''}',
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
        color: primary ? (s.hovered ? Palette.leaf600 : Palette.leaf500) : (s.hovered ? Palette.cream200 : Palette.cream50),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
        child: Text(label, style: KitText.xs.copyWith(color: primary ? Palette.cream50 : Palette.bark800)),
      ),
    ),
  );
}

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
    final agents = (ref.watch(agentsProvider).value ?? const <String, Agent>{}).values.where((a) => a.enabled);
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
                        color: on ? Palette.leaf500 : (s.hovered ? Palette.cream200 : Palette.cream50),
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        child: Text(n.title, style: KitText.xs.copyWith(color: on ? Palette.cream50 : Palette.bark800)),
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
