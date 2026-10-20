import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../ui/pixel/pixel.dart';
import 'chat_widgets.dart';

/// Only while the manager thinks or speaks: it ends that run, and the helpers it sent keep working. [builder] draws the button.
class ManagerStopControl extends ConsumerWidget {
  const ManagerStopControl({super.key, required this.builder});
  final Widget Function(BuildContext context, VoidCallback stop) builder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manager = ref.watch(stateProvider.select((s) => s?.manager));
    if (manager != ManagerState.thinking && manager != ManagerState.speaking) return const SizedBox.shrink();
    return builder(context, () => unawaited(ref.read(farmCommandsProvider).stopManager().catchError((Object _) {})));
  }
}

/// The pixel kit's stop button.
class ManagerStopButton extends StatelessWidget {
  const ManagerStopButton({super.key, this.size = 28});
  final double size;

  @override
  Widget build(BuildContext context) => ManagerStopControl(
    builder: (context, stop) => Padding(
      padding: const EdgeInsets.only(right: 4),
      child: PxButton(
        size: PxSize.custom,
        tone: PxTone.danger,
        tooltip: '叫管家停下这一轮，派出去的帮工照常干活',
        semanticLabel: '叫停管家',
        onPressed: stop,
        child: SizedBox.square(
          dimension: size,
          child: const Center(child: Glyph('button-stop')),
        ),
      ),
    ),
  );
}
