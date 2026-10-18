import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../data/remote.dart';
import '../shared/widgets.dart';

enum RuntimeBusy { refreshing }

final runtimeBusyProvider = NotifierProvider<RuntimeCommands, Map<String, RuntimeBusy>>(RuntimeCommands.new);

class RuntimeCommands extends Notifier<Map<String, RuntimeBusy>> {
  @override
  Map<String, RuntimeBusy> build() => const {};

  RuntimeCatalog get _catalog => ref.read(runtimeCatalogProvider.notifier);

  void _set(String id, RuntimeBusy? what) => state = {
    for (final e in state.entries)
      if (e.key != id) e.key: e.value,
    id: ?what,
  };

  Future<void> _withBusy(String id, RuntimeBusy what, Future<void> Function() run) async {
    _set(id, what);
    try {
      await runAction(run);
    } finally {
      if (ref.mounted) _set(id, null);
    }
  }

  Future<void> refresh(String id) => _withBusy(id, RuntimeBusy.refreshing, () => _catalog.refresh(id));

  Future<void> update(String id, RuntimeSettings settings) async {
    await runAction(() => _catalog.saveSettings(id, settings));
  }
}
