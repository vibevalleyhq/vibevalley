import 'dart:async';

import '../data/server.dart';
import '../gen/vibevalley.dart';
import '../ui/toasts.dart';

/// The debug console's 升一级 and 弹一个成就.
final localEffects = StreamController<GameEffect>.broadcast();

Stream<GameEffect> farmEffects(VibeValleyServer server) {
  late final StreamController<GameEffect> out;
  final subs = <StreamSubscription<GameEffect>>[];
  out = StreamController<GameEffect>.broadcast(
    onListen: () {
      subs
        ..add(server.frames.expand((f) => f.frame.effects).listen(out.add))
        ..add(localEffects.stream.listen(out.add));
    },
    onCancel: () {
      for (final s in subs) {
        unawaited(s.cancel());
      }
      subs.clear();
    },
  );
  return out.stream;
}

const clearingLevels = {5, 8, 12};

String? toastKicker(ToastData toast) {
  final data = toast.data;
  if (toast.type != ToastType.achievement || data is! GameEffectAchievement) return null;
  return data.reached;
}
