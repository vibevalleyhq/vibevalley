import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../game/commands.dart';
import '../gen/vibevalley.dart';

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
