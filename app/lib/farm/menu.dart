// The game menu (web/src/pixel/Hud.tsx GameMenu, opened by Esc or the HUD's 菜单): go on, back to the title screen,
// sound on or off, the debug console, the other pages, and what in the yard can be clicked. The web page's 自动演示
// makes up requests on the mock only, so it is not here.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../game/state.dart';
import '../shell/debug/debug_panel.dart' show debugOpenProvider;
import '../shell/prefs.dart';
import '../shell/title/title_state.dart';
import '../ui/kit/kit.dart';
import '../village/world.dart' show spotNames;

class GameMenu extends ConsumerWidget {
  const GameMenu({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final muted = ref.watch(prefsProvider.select((p) => p.muted));
    final debug = ref.watch(debugOpenProvider);
    void close() => ref.read(menuOpenProvider.notifier).set(false);
    void leave(String to) {
      close();
      context.go(to);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PxButton.text('继续', tone: PxTone.primary, onPressed: close),
        const SizedBox(height: 8),
        PxButton.text(
          '回到首页',
          onPressed: () {
            close();
            ref.read(titleOpenProvider.notifier).show();
          },
        ),
        const SizedBox(height: 8),
        PxButton.text(muted ? '打开音效' : '关闭音效', onPressed: () => ref.read(prefsProvider.notifier).setMuted(!muted)),
        const SizedBox(height: 8),
        PxButton.text(
          '${debug ? '关上调试台' : '打开调试台'}（`）',
          onPressed: () {
            close();
            ref.read(debugOpenProvider.notifier).set(!debug);
          },
        ),
        FarmSection(
          title: '去别处',
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              PxButton.text('田头（频道）', onPressed: () => leave('/chat')),
              PxButton.text('地图', onPressed: () => leave('/map')),
              PxButton.text('帮工名册', onPressed: () => leave('/agents')),
              PxButton.text('农具', onPressed: () => leave('/runtimes')),
              PxButton.text('技能书', onPressed: () => leave('/skills')),
              PxButton.text('连接器', onPressed: () => leave('/connectors')),
              PxButton.text('项目', onPressed: () => leave('/projects')),
              PxButton.text('图鉴', onPressed: () => leave('/assets')),
            ],
          ),
        ),
        FarmSection(
          title: '院子里能点的',
          child: LayoutBuilder(
            builder: (context, box) => Wrap(
              spacing: 12,
              runSpacing: 4,
              children: [
                for (final MapEntry(key: _, value: (label, hint)) in spotNames.entries)
                  SizedBox(
                    width: (box.maxWidth - 12) / 2,
                    child: Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(
                            text: label,
                            style: const TextStyle(color: Palette.bark900),
                          ),
                          TextSpan(
                            text: ' · $hint',
                            style: const TextStyle(color: Palette.bark500),
                          ),
                        ],
                      ),
                      style: KitText.xs.copyWith(color: Palette.bark800),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
