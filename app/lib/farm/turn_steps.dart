import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/remote.dart' show runEventsProvider;
import 'work_log.dart';
import '../gen/vibevalley.dart';
import '../ui/pixel/pixel.dart';

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
    final steps = ref.watch(runEventsProvider((session: widget.id, run: run))).value;
    final turn = steps ?? const <SessionEvent>[];
    final label = turnLabel(turn, manager: widget.manager);
    if (label == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Tappable(
              onTap: () {
                setState(() => _open = !_open);
              },
              builder: (context, s) => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SpriteIcon('icon-log', size: 14),
                  const SizedBox(width: 4),
                  Text(
                    _open ? '$label · 收起' : '$label · 看看',
                    style: PxText.xs.copyWith(
                      color: s.hovered ? Palette.bark900 : Palette.bark600,
                      decoration: TextDecoration.underline,
                      decorationColor: s.hovered ? Palette.bark600 : Palette.cream300,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: WorkLog(steps: turn, now: DateTime.now().millisecondsSinceEpoch.toDouble(), asked: '收到'),
            ),
        ],
      ),
    );
  }
}
