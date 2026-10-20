import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../ui/kit/kit.dart';
import 'chat_widgets.dart';

/// Only while the manager thinks or speaks: it ends that run, and the helpers it sent keep working.
class ManagerStopButton extends ConsumerWidget {
  const ManagerStopButton({super.key, this.size = 28});
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manager = ref.watch(stateProvider.select((s) => s?.manager));
    if (manager != ManagerState.thinking && manager != ManagerState.speaking) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: PxButton(
        size: PxSize.custom,
        tone: PxTone.danger,
        tooltip: '叫管家停下这一轮，派出去的帮工照常干活',
        semanticLabel: '叫停管家',
        onPressed: () => unawaited(ref.read(farmCommandsProvider).stopManager().catchError((Object _) {})),
        child: SizedBox.square(
          dimension: size,
          child: const Center(child: Glyph('button-stop')),
        ),
      ),
    );
  }
}
