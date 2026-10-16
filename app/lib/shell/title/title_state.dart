// The title screen's rules (packages/core title.ts): what the app opens on, before the farm. 开始游戏 goes in and starts
// the day (开工); 继续游戏 goes back to the farm as it was, when there is one to go back to; 设置 holds the farm's keys
// (DeepSeek, Agora), saved by the server in $VIBEVALLEY_HOME/settings.json.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../data/providers.dart';
import '../../gen/vibevalley.dart';

/// Whether the title screen is up: when the app opens for the first time on this device, and when asked for again
/// (the game menu's 回到首页).
final titleOpenProvider = NotifierProvider<TitleOpen, bool>(TitleOpen.new);

/// Whether the farm was ever entered on this device: the title screen is for the first opening, not every one.
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

  /// Leaves the title screen for the farm; `start` begins the day as well (开工). Later openings go straight to the farm.
  void enterFarm({required bool start}) {
    state = false;
    if (start) unawaited(ref.read(serverProvider).api.farm.start().catchError((Object _) {}));
    unawaited(() async {
      try {
        await (await SharedPreferences.getInstance()).setBool(_seenKey, true);
      } on Object {
        // No storage: it shows again next time.
      }
    }());
  }

  /// Back to the title screen (the game menu's 回到首页).
  void show() => state = true;
}

/// Whether there is a farm to go back to: helpers on it, words in the chat, coins earned.
bool hasFarm(FarmState? farm) => farm != null && (farm.helpers.isNotEmpty || (farm.chat?.messages.length ?? 0) > 0 || (farm.progress?.coins ?? 0) > 0);

/// Whether the manager can think: it needs DeepSeek's key (from settings, the environment or pi).
bool managerReady(SettingsStatus? status) => status?.deepseekApiKey.source != null;

/// The keys as the server last told them; null before it answered.
final settingsProvider = NotifierProvider<SettingsNotifier, SettingsStatus?>(SettingsNotifier.new);

class SettingsNotifier extends Notifier<SettingsStatus?> {
  @override
  SettingsStatus? build() => null;

  /// Asks the server for the keys; throws why not.
  Future<void> load() async => state = await ref.read(serverProvider).api.farm.settings();

  /// Saves what changed and takes the server's answer; throws why not.
  Future<void> save(SettingsUpdate update) async => state = await ref.read(serverProvider).api.farm.saveSettings(body: update);
}
