// Open, it is a window of a fixed size drawn up over the picture from its input row, so the farm never rescales.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart' hide Icon;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../chat/chat_widgets.dart';
import '../host/desktop.dart';
import '../ui/kit/kit.dart';
import '../voice/voice.dart';

const _mood = {'speaking': '在说话', 'listening': '在听', 'thinking': '在想', 'idle': '在听', 'silent': '在听'};

class ChatVoiceToggle extends ConsumerWidget {
  const ChatVoiceToggle({super.key, required this.call});
  final VoiceCall call;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final desktop = ref.watch(desktopProvider);
    final live = call.phase == CallPhase.live;
    final joining = call.phase == CallPhase.connecting;
    final leaving = call.phase == CallPhase.ending;
    final error = call.phase == CallPhase.idle && call.problem != null;
    final tip = live
        ? '挂断语音。管家${call.agentHere ? (_mood[call.agentState] ?? '在听') : '还在路上'}'
        : joining
        ? '正在接通管家…'
        : leaving
        ? '挂断中…'
        : error
        ? '上次没接通：${call.problem}。再按一下重试'
        : '按一下，和管家语音说话${desktop.isDesktop && desktop.voiceShortcut.isNotEmpty ? '（别的程序在前面时按 ${shortcutText(desktop.voiceShortcut)}）' : ''}';
    final fill = leaving
        ? Palette.cream300
        : live
        ? Palette.berry
        : error
        ? const Color(0xFFC9813A)
        : Palette.leaf500;
    return KitTappable(
      onTap: leaving ? null : () => unawaited(live || joining ? call.end() : call.start()),
      tooltip: tip,
      semanticLabel: live || joining ? '挂断语音' : '语音说话',
      selected: live,
      builder: (context, s) => Transform.translate(
        offset: Offset(0, s.pressed ? 1 : 0),
        child: Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: !live && !error && !leaving && s.hovered ? Palette.leaf600 : fill,
            boxShadow: const [BoxShadow(color: Color(0x2E000000), offset: Offset(0, 3))],
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              if (live)
                Positioned.fill(
                  child: Transform.scale(
                    scale: 1 + math.min(1, call.micLevel / 255 * 1.6) * .45,
                    child: Container(color: Palette.berry.withValues(alpha: .35)),
                  ),
                ),
              if (joining || leaving)
                const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Palette.cream50, backgroundColor: Color(0x80F7E8C4)),
                )
              else
                Glyph(live ? 'button-hangup' : 'button-mic'),
            ],
          ),
        ),
      ),
    );
  }
}

class ChatLevelBars extends StatelessWidget {
  const ChatLevelBars({super.key, required this.level, required this.tone});
  final double level;
  final Color tone;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: SizedBox(
      height: 14,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, weight) in const [.55, .85, 1.0, .75, .5].indexed)
            AnimatedContainer(
              duration: const Duration(milliseconds: 100),
              curve: Curves.easeOut,
              margin: EdgeInsets.only(left: i == 0 ? 0 : 3),
              width: 3,
              height: 14 * (math.max(18, math.min(100, 18 + level * weight * 150)) / 100),
              color: tone,
            ),
        ],
      ),
    ),
  );
}
