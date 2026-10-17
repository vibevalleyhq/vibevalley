import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/state.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import '../rules/playbook.dart';

const _actorTone = {
  PlaybookActor.user: (Palette.leaf500, Palette.cream50),
  PlaybookActor.manager: (Color(0xFFEFD08F), Palette.bark900),
  PlaybookActor.system: (Palette.cream200, Palette.bark900),
};

String _when(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

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
              Text(e.text ?? '', style: KitText.xs.copyWith(color: Palette.bark800)),
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
