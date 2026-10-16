import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../desktop/launcher.dart' show embeddedServerAddress;
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import 'farm_choice.dart';
import 'server.dart';

const serverAddress = String.fromEnvironment('VIBEVALLEY_SERVER', defaultValue: 'http://127.0.0.1:8787');

/// Read once: the app is rebuilt when the choice changes.
final serverProvider = Provider<VibeValleyServer>((ref) {
  final remote = farmChoice.value.using;
  final server = remote != null ? VibeValleyServer(remote.url, key: remote.key) : VibeValleyServer(Uri.parse(embeddedServerAddress ?? serverAddress));
  ref.onDispose(server.close);
  return server;
});

final stateFrameProvider = StreamProvider<StateFrame>((ref) => ref.watch(serverProvider).frames);

final farmProvider = Provider<FarmState?>((ref) => ref.watch(stateFrameProvider).value?.state);

final inboxProvider = Provider<List<InboxItem>>((ref) => ref.watch(stateFrameProvider).value?.frame.inbox ?? const []);

final plansProvider = Provider<List<Playbook>>((ref) => ref.watch(stateFrameProvider).value?.frame.plans ?? const []);

final viewProvider = Provider<FarmView?>((ref) => ref.watch(stateFrameProvider).value?.frame.view);

final effectsProvider = StreamProvider<GameEffect>((ref) => ref.watch(serverProvider).frames.expand((f) => f.frame.effects));

final streamProblemProvider = StreamProvider<String>((ref) => ref.watch(serverProvider).problems.stream);

final sideEventsProvider = StreamProvider<SiteEvent>((ref) => ref.watch(serverProvider).sideEvents);

final atlasProvider = FutureProvider<SpriteAtlas>((ref) => SpriteAtlas.load(rootBundle));
