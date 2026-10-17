import 'package:flutter/material.dart';

import '../../audio/sfx.dart';
import '../../ui/kit/kit.dart';
import 'catalog_page.dart';

class SoundsShelf extends StatelessWidget {
  const SoundsShelf({super.key});

  @override
  Widget build(BuildContext context) {
    final mono = KitText.mono.copyWith(fontSize: 12, color: Palette.bark800);
    return ListView(
      children: gapped([
        PxCard(
          child: Text.rich(
            TextSpan(
              children: [
                const TextSpan(text: '音效都是现合成的，没有音频文件：配方在 '),
                TextSpan(text: 'lib/audio/sfx.dart', style: mono),
                const TextSpan(text: '。关了音效就听不到。背景音乐还没有，给 Suno 的提示词在 '),
                TextSpan(text: 'design/music/suno-prompts.md', style: mono),
                const TextSpan(text: '。'),
              ],
            ),
            style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625),
          ),
        ),
        for (final g in soundGroups)
          PxCard(
            title: g.title,
            child: Wrap(spacing: 8, runSpacing: 8, children: [for (final name in g.names) _SoundButton(name: name)]),
          ),
      ]),
    );
  }
}

class _SoundButton extends StatelessWidget {
  const _SoundButton({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: () => Sfx.play(name),
    semanticLabel: '播放 ${soundLabel[name] ?? name}',
    builder: (context, s) {
      Widget b = Container(
        padding: const EdgeInsets.fromLTRB(8, 6, 14, 6),
        color: s.hovered ? Palette.cream300 : Palette.cream200,
        foregroundDecoration: pxRing,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox.square(dimension: 24, child: Center(child: SpriteIcon('button-play', size: 20))),
            const SizedBox(width: 8),
            Text(soundLabel[name] ?? name, style: KitText.sm.copyWith(color: Palette.bark800)),
            const SizedBox(width: 8),
            Text(name, style: KitText.mono.copyWith(color: Palette.bark500)),
          ],
        ),
      );
      if (s.pressed) b = Transform.translate(offset: const Offset(0, 1), child: b);
      return b;
    },
  );
}
