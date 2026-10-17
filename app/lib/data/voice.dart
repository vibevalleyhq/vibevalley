import 'package:flutter_riverpod/legacy.dart';

import '../voice/voice.dart';
import 'prefs.dart';
import 'providers.dart';

// The chosen farm's scope owns its call; pages observe it and never own RTC resources.
final voiceCallProvider = ChangeNotifierProvider<VoiceCall>((ref) {
  return VoiceCall(
    ref.watch(apiProvider),
    agentPick: () {
      final pick = ref.read(prefsProvider).pick;
      return pick == 'auto' ? null : pick;
    },
  );
});
