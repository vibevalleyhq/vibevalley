import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/remote.dart' show runEventsProvider;
import '../../gen/vibevalley.dart';
import '../../shared/work_log_rules.dart' show turnLabel;
import '../../ui/pro/pro.dart';
import '../shared/work_log.dart';

/// Under a report or the manager's answer: the run behind it, folded to one line until opened.
class TurnSteps extends ConsumerStatefulWidget {
  const TurnSteps({super.key, required this.id, required this.run, this.manager = false});
  final String id;
  final String? run;
  final bool manager;

  @override
  ConsumerState<TurnSteps> createState() => _TurnStepsState();
}

class _TurnStepsState extends ConsumerState<TurnSteps> {
  var _open = false;

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    // A message with no run behind it (or one not loaded yet) says nothing about one.
    if (run == null) return const SizedBox.shrink();
    final turn = ref.watch(runEventsProvider((session: widget.id, run: run))).value ?? const <SessionEvent>[];
    final label = turnLabel(turn, manager: widget.manager);
    if (label == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Tappable(
              onTap: () => setState(() => _open = !_open),
              semanticLabel: _open ? '收起干活过程' : '看看干活过程',
              builder: (context, s) => Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(color: s.hovered ? ProColor.hover : null, borderRadius: proRadius),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const SpriteIcon('icon-log', size: 14),
                    const SizedBox(width: 6),
                    Text(
                      label,
                      style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w500),
                    ),
                    const SizedBox(width: 4),
                    Opacity(opacity: .6, child: SpriteIcon(_open ? 'button-collapse' : 'button-enlarge', size: 10)),
                  ],
                ),
              ),
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: WorkLog(steps: turn, now: DateTime.now().millisecondsSinceEpoch.toDouble(), asked: '收到'),
            ),
        ],
      ),
    );
  }
}
