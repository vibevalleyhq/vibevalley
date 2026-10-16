// What the app reads, as Riverpod providers: the server, its folded state (the one stream every screen watches), and
// the sprite atlas. Screens hold no copy of the farm: they watch `farmProvider`.

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../desktop/launcher.dart' show embeddedServerAddress;
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import 'farm_choice.dart';
import 'server.dart';

/// The server's address: http://127.0.0.1:8787 unless built with --dart-define=VIBEVALLEY_SERVER=….
const serverAddress = String.fromEnvironment('VIBEVALLEY_SERVER', defaultValue: 'http://127.0.0.1:8787');

/// Another machine's farm when the app uses one (farm_choice.dart); else the farm the desktop app started inside
/// itself (lib/desktop) when there is one; serverAddress otherwise. Read once: the app is rebuilt when the choice changes.
final serverProvider = Provider<VibeValleyServer>((ref) {
  final remote = farmChoice.value.using;
  final server = remote != null ? VibeValleyServer(remote.url, key: remote.key) : VibeValleyServer(Uri.parse(embeddedServerAddress ?? serverAddress));
  ref.onDispose(server.close);
  return server;
});

/// The latest frame off GET /api/site/state, with what it cost (size, decode time).
final stateFrameProvider = StreamProvider<StateFrame>((ref) => ref.watch(serverProvider).frames);

/// The farm's core state, as the server folded it.
final farmProvider = Provider<FarmState?>((ref) => ref.watch(stateFrameProvider).value?.state);

/// What needs the person now (protocol's inbox.go), newest first: the phone rings it, the desktop bell notifies it.
final inboxProvider = Provider<List<InboxItem>>((ref) => ref.watch(stateFrameProvider).value?.frame.inbox ?? const []);

/// The playbooks (种植计划): the issues with a plan, each with its sub-issues as the steps (protocol's plan_issues.go),
/// oldest first.
final plansProvider = Provider<List<Playbook>>((ref) => ref.watch(stateFrameProvider).value?.frame.plans ?? const []);

/// What the farm makes of the state, computed by the server (protocol's view.go): the level, the plots.
final viewProvider = Provider<FarmView?>((ref) => ref.watch(stateFrameProvider).value?.frame.view);

/// The effects to play (coins, level-ups, achievements, penalties), as they come: each frame's, once.
final effectsProvider = StreamProvider<GameEffect>((ref) => ref.watch(serverProvider).frames.expand((f) => f.frame.effects));

/// Why the state is not coming through, when an attempt failed for another reason than the server being down.
final streamProblemProvider = StreamProvider<String>((ref) => ref.watch(serverProvider).problems.stream);

/// What happens beside the core state, as it comes (GET /api/site/events without the facts): steps, notices, runtimes.
final sideEventsProvider = StreamProvider<SiteEvent>((ref) => ref.watch(serverProvider).sideEvents);

final atlasProvider = FutureProvider<SpriteAtlas>((ref) => SpriteAtlas.load(rootBundle));
