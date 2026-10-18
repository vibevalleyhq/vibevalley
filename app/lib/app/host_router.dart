// The native menu's commands are app-level navigation: turn one into a farm page, a panel or a selected thing.
// The chosen farm scope owns the call as well as its navigation state.

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../chat/chat_state.dart' show chatActionsProvider, chatOpenProvider;
import '../data/ui_state.dart';
import '../data/voice.dart';
import '../host/desktop.dart' show hostProvider;
import '../host/command.dart';
import 'router.dart';

final hostCommandRouterProvider = Provider<void>((ref) {
  final sub = ref.watch(hostProvider).commands.listen((command) {
    if (command is HostVoice) {
      unawaited(ref.read(voiceCallProvider).toggle());
      return;
    }
    _toFarm(ref);
    switch (command) {
      case HostVoice():
        return;
      case HostOpenSession(:final id):
        ref.read(farmOverlaysProvider.notifier).select(id);
      case HostOpenChat(:final conversation):
        ref.read(chatOpenProvider.notifier).set(true);
        unawaited(ref.read(chatActionsProvider).showChat(conversation).catchError((Object _) {}));
      case HostOpenTaskBoard(:final graph):
        ref.read(graphShownProvider.notifier).set(graph);
        ref.read(farmOverlaysProvider.notifier).panel(FarmPanel.taskBoard);
      case HostOpenAchievements():
        ref.read(farmOverlaysProvider.notifier).panel(FarmPanel.graphs);
    }
  });
  ref.onDispose(sub.cancel);
});

/// The title screen asks for a page (leaveForProvider): go there.
final leaveForRouterProvider = Provider<void>((ref) {
  ref.listen(leaveForProvider, (_, path) {
    if (path == null) return;
    router.go(path);
    ref.read(leaveForProvider.notifier).set(null);
  });
});

void _toFarm(Ref ref) {
  ref.read(titleOpenProvider.notifier).enterFarm(start: false);
  if (router.routerDelegate.currentConfiguration.uri.path != '/') router.go('/');
}
