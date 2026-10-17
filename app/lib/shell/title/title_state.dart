import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';

final titleOpenProvider = NotifierProvider<TitleOpen, bool>(TitleOpen.new);

/// The title screen is for the first opening, not every one.
const _seenKey = 'vibevalley.title.seen';

class TitleOpen extends Notifier<bool> {
  @override
  bool build() {
    unawaited(_skipWhenSeen());
    return true;
  }

  Future<void> _skipWhenSeen() async {
    try {
      if ((await SharedPreferences.getInstance()).getBool(_seenKey) ?? false) state = false;
    } on Object {
      // No storage: the title screen shows, as the first time.
    }
  }

  void enterFarm({required bool start}) {
    state = false;
    if (start) unawaited(ref.read(apiProvider).server.start().catchError((Object _) {}));
    unawaited(() async {
      try {
        await (await SharedPreferences.getInstance()).setBool(_seenKey, true);
      } on Object {
        // No storage: it shows again next time.
      }
    }());
  }

  void show() => state = true;
}

bool hasFarm(CoreState? farm) => farm != null && (farm.workers.isNotEmpty || (farm.chat?.messages.length ?? 0) > 0 || (farm.progress?.coins ?? 0) > 0);

bool managerReady(SettingsStatus? status) => status?.deepseekApiKey.source != null;

final settingsProvider = NotifierProvider<SettingsNotifier, SettingsStatus?>(SettingsNotifier.new);

class SettingsNotifier extends Notifier<SettingsStatus?> {
  @override
  SettingsStatus? build() => null;

  Future<void> load() async => state = await ref.read(apiProvider).setting.load();

  Future<void> save(SettingsUpdate update) async => state = await ref.read(apiProvider).setting.save(body: update);
}
