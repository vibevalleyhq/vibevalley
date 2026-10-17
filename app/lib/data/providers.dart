import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import 'farm_choice.dart';
import 'server.dart';

const serverAddress = String.fromEnvironment('VIBEVALLEY_SERVER', defaultValue: 'http://127.0.0.1:8787');

/// The server the macOS app started itself, which wins over serverAddress; null otherwise. Set by the desktop shell
/// (startDesktop) before the app's first frame.
String? embeddedServerAddress;

/// Read once: the app is rebuilt when the choice changes.
final serverProvider = Provider<VibeValleyServer>((ref) {
  final remote = farmChoice.value.using;
  final server = remote != null ? VibeValleyServer(remote.url, key: remote.key) : VibeValleyServer(Uri.parse(embeddedServerAddress ?? serverAddress));
  ref.onDispose(server.close);
  return server;
});

final apiProvider = Provider<VibeValleyApi>((ref) => ref.watch(serverProvider).api);

final stateFrameProvider = StreamProvider<ReceivedFrame>((ref) => ref.watch(serverProvider).frames);

final farmProvider = Provider<CoreState?>((ref) => ref.watch(stateFrameProvider).value?.state);

final inboxProvider = Provider<List<InboxItem>>((ref) => ref.watch(stateFrameProvider).value?.frame.inbox ?? const []);

final plansProvider = Provider<List<Playbook>>((ref) => ref.watch(stateFrameProvider).value?.frame.plans ?? const []);

final viewProvider = Provider<FarmView?>((ref) => ref.watch(stateFrameProvider).value?.frame.view);

final effectsProvider = StreamProvider<GameEffect>((ref) => ref.watch(serverProvider).frames.expand((f) => f.frame.effects));

final streamProblemProvider = StreamProvider<String>((ref) => ref.watch(serverProvider).problems.stream);

final sideEventsProvider = StreamProvider<SideEvent>((ref) => ref.watch(serverProvider).sideEvents);

final atlasProvider = FutureProvider<SpriteAtlas>((ref) => SpriteAtlas.load(rootBundle));
