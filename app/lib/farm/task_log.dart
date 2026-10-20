import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../ui/pixel/pixel.dart';
import '../rules/task.dart';

(Color, Color) _actorTone(GraphActor actor) => switch (actor) {
  GraphActor.user => (Palette.leaf500, Palette.cream50),
  GraphActor.manager => (const Color(0xFFEFD08F), Palette.bark900),
  GraphActor.session => (const Color(0xFFBFD7EA), Palette.bark900),
  GraphActor.system => (Palette.cream200, Palette.bark900),
};

String _when(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

class TaskLog extends ConsumerStatefulWidget {
  const TaskLog({super.key, required this.graph, required this.only, required this.onAll});
  final TaskGraph graph;
  final String? only;
  final VoidCallback onAll;

  @override
  ConsumerState<TaskLog> createState() => _TaskLogState();
}

class _TaskLogState extends ConsumerState<TaskLog> {
  @override
  void initState() {
    super.initState();
    _load();
  }

  // Loaded when shown, and again whenever the task changes: something happened.
  @override
  void didUpdateWidget(TaskLog old) {
    super.didUpdateWidget(old);
    if (old.graph != widget.graph) _load();
  }

  void _load() => ref.read(graphLogProvider.notifier).load(widget.graph.id).catchError((Object _) {});

  @override
  Widget build(BuildContext context) {
    final graph = widget.graph;
    final events = ref.watch(graphLogProvider.select((all) => all[graph.id]));
    String titleOf(String id) => taskOf(graph, id)?.title ?? id;
    final only = widget.only;
    final shown = (events ?? const <GraphEvent>[]).where((e) => only == null || e.task == only).toList().reversed.toList();
    return FarmSection(
      title: only == null ? '经过' : '「${titleOf(only)}」的经过',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (only != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Tappable(
                onTap: widget.onAll,
                builder: (context, s) => Container(
                  color: s.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                  child: Text('看整个计划的经过', style: PxText.xs.copyWith(color: Palette.bark800)),
                ),
              ),
            ),
          if (shown.isEmpty)
            Text(events != null ? '还没有记下什么。' : '正在读…', style: PxText.sm.copyWith(color: Palette.bark600))
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
                      child: TaskLogRow(e: e, titleOf: titleOf),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class TaskLogRow extends StatefulWidget {
  const TaskLogRow({super.key, required this.e, required this.titleOf});
  final GraphEvent e;
  final String Function(String) titleOf;

  @override
  State<TaskLogRow> createState() => _TaskLogRowState();
}

class _TaskLogRowState extends State<TaskLogRow> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final e = widget.e;
    final (fill, ink) = _actorTone(e.actor);
    final changes = e.changes ?? const <TaskFieldChange>[];
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 88,
          child: Text(_when(e.at), style: PxText.xs.copyWith(color: Palette.bark400)),
        ),
        const SizedBox(width: 8),
        SizedBox(
          width: 44,
          child: Container(
            color: fill,
            padding: const EdgeInsets.symmetric(vertical: 2),
            alignment: Alignment.center,
            child: Text(e.actorText ?? '', style: PxText.xs.copyWith(fontSize: 10, color: ink)),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(e.text ?? '', style: PxText.xs.copyWith(color: Palette.bark800)),
              if (changes.isNotEmpty) ...[
                Tappable(
                  onTap: () => setState(() => _open = !_open),
                  builder: (context, s) => Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text('改前改后', style: PxText.xs.copyWith(color: Palette.bark600)),
                  ),
                ),
                if (_open)
                  for (final c in changes)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(c.field, style: PxText.xs.copyWith(color: Palette.bark600)),
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
                            style: PxText.xs.copyWith(color: Palette.bark600),
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
