import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../gen/vibevalley.dart';
import 'prefs.dart';
import 'providers.dart';
import 'remote.dart' show agentsProvider;
import 'server.dart' show connectWait;

final messagesProvider = Provider<Messages>(Messages.new);

class Messages {
  Messages(this.ref);
  final Ref ref;
  Future<bool>? _opening;

  Future<bool> _ready() => _opening ??= _connect().whenComplete(() => _opening = null);

  Future<bool> _connect() async {
    if (!ref.mounted) return false;
    final now = ref.read(stateProvider)?.call;
    if (now == CallState.live) return true;
    if (now != CallState.connecting) await ref.read(apiProvider).manager.open().timeout(connectWait);
    final deadline = DateTime.now().add(connectWait);
    while (DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      if (!ref.mounted) return false;
      final call = ref.read(stateProvider)?.call;
      if (call == CallState.live) return true;
      if (call == CallState.error) throw StateError('管家没连上，请重试');
    }
    throw TimeoutException('等管家接通超时，请重试', connectWait);
  }

  Future<void> send(String text, {Conversation? conversation, int? bed, String? agent}) async {
    final said = text.trim();
    if (said.isEmpty || !await _ready()) return;
    final pick = ref.read(prefsProvider).pick;
    final agents = pick == 'auto' || agent != null ? null : ref.read(agentsProvider).value;
    final chosen = pick != 'auto' && agents != null && agents.containsKey(pick) ? pick : null;
    await ref
        .read(apiProvider)
        .channel
        .say(
          body: SayRequest(
            text: said,
            conversation: conversation?.kind == ConversationKind.general ? null : conversation?.id,
            bed: bed?.toDouble(),
            agent: agent ?? chosen,
          ),
        );
  }
}
