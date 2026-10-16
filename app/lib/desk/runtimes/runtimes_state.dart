// Each answer is the runtime as it is now; the config is loaded again to show it (the server also pushes the change on its events).

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../shared/state.dart';
import '../shared/widgets.dart';

enum RuntimeBusy { refreshing, upgrading }

final runtimeBusyProvider = NotifierProvider<RuntimeCommands, Map<String, RuntimeBusy>>(RuntimeCommands.new);

class RuntimeCommands extends Notifier<Map<String, RuntimeBusy>> {
  @override
  Map<String, RuntimeBusy> build() => const {};

  VibeValleyApi get _api => ref.read(deskApiProvider);

  void _set(String id, RuntimeBusy? what) => state = {
    for (final e in state.entries)
      if (e.key != id) e.key: e.value,
    id: ?what,
  };

  Future<void> _withBusy(String id, RuntimeBusy what, Future<RuntimeInfo> Function() run) async {
    _set(id, what);
    try {
      if (await deskRun(run) != null) await ref.read(deskConfigProvider.notifier).refresh();
    } finally {
      if (ref.mounted) _set(id, null);
    }
  }

  Future<void> refresh(String id) => _withBusy(id, RuntimeBusy.refreshing, () => _api.farm.refreshRuntime(id: id));

  Future<void> upgrade(String id) => _withBusy(id, RuntimeBusy.upgrading, () => _api.farm.upgradeRuntime(id: id));

  Future<void> update(String id, RuntimeSettings settings) async {
    if (await deskRun(() => _api.farm.updateRuntime(id: id, body: settings)) != null) await ref.read(deskConfigProvider.notifier).refresh();
  }
}
