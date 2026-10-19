import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import 'server_choice.dart';
import 'server.dart';

const serverAddress = String.fromEnvironment('VIBEVALLEY_SERVER', defaultValue: 'http://127.0.0.1:8787');

final serverConnectionProvider = Provider<ServerConnection>((ref) => serverConnection.value);

final serverProvider = Provider<VibeValleyServer>((ref) {
  final server = ref.watch(serverConnectionProvider).open(serverAddress);
  ref.onDispose(server.close);
  return server;
});

final apiProvider = Provider<VibeValleyApi>((ref) => ref.watch(serverProvider).api);

final stateFrameProvider = StreamProvider<ReceivedFrame>((ref) => ref.watch(serverProvider).frames);

final stateProvider = Provider<CoreState?>((ref) => ref.watch(stateFrameProvider).value?.state);

final inboxProvider = Provider<List<InboxItem>>((ref) => ref.watch(stateFrameProvider).value?.frame.inbox ?? const []);

final graphsProvider = Provider<List<TaskGraph>>((ref) => ref.watch(stateFrameProvider).value?.frame.graphs ?? const []);

final viewProvider = Provider<FarmView?>((ref) => ref.watch(stateFrameProvider).value?.frame.view);

final effectsProvider = StreamProvider<GameEffect>((ref) => ref.watch(serverProvider).frames.expand((f) => f.frame.effects));

final streamProblemProvider = StreamProvider<String>((ref) => ref.watch(serverProvider).problems.stream);

final sideEventsProvider = StreamProvider<LiveEvent>((ref) => ref.watch(serverProvider).sideEvents);

final atlasProvider = FutureProvider<SpriteAtlas>((ref) => SpriteAtlas.load(rootBundle));
