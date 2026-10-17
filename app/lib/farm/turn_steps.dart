import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../chat/chat_state.dart' show chatTurnSteps;
import '../data/remote.dart' show workStepsProvider;
import '../shared/work_log.dart';
import '../game/state.dart' show turnEndingAt;
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';

final _preloaded = <String>{};

class TurnSteps extends ConsumerStatefulWidget {
  const TurnSteps({super.key, required this.id, required this.at, this.manager = false});
  final String id;
  final double at;
  final bool manager;

  @override
  ConsumerState<TurnSteps> createState() => _TurnStepsState();
}

class _TurnStepsState extends ConsumerState<TurnSteps> {
  var _open = false;

  void _load() => ref.read(workStepsProvider.notifier).load(widget.id).then((_) {}, onError: (Object _) {});

  @override
  void initState() {
    super.initState();
    // The manager's trajectory is read once per run, for the count under its messages; step events keep it up.
    if (widget.manager && _preloaded.add(widget.id)) _load();
  }

  @override
  Widget build(BuildContext context) {
    final steps = ref.watch(workStepsProvider.select((all) => all[widget.id]));
    final turn = steps == null ? const <SessionEvent>[] : turnEndingAt(steps, widget.at);
    final tools = turn.where((s) => s.type == SessionEventType.toolCall).length;
    if (widget.manager && tools == 0) return const SizedBox.shrink();
    final label = tools > 0 ? '用了 $tools 个工具' : '这一轮的干活过程';
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: KitTappable(
              onTap: () {
                // A helper's steps here may be only those since it opened: the whole trajectory comes first.
                if (!_open && !widget.manager) _load();
                setState(() => _open = !_open);
              },
              builder: (context, s) => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const SpriteIcon('icon-log', size: 14),
                  const SizedBox(width: 4),
                  Text(
                    _open ? '$label · 收起' : '$label · 看看',
                    style: KitText.xs.copyWith(
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
              child: turn.isNotEmpty
                  ? WorkLog(steps: turn, now: DateTime.now().millisecondsSinceEpoch.toDouble(), asked: '收到')
                  : Text(steps != null ? '这一轮没有记下步骤：可能已经过了保留的日子。' : '在读……', style: KitText.xs.copyWith(color: Palette.bark500)),
            ),
        ],
      ),
    );
  }
}

void installTurnSteps() => chatTurnSteps = (context, id, at, {required manager}) => TurnSteps(id: id, at: at, manager: manager);
