import 'package:flutter/material.dart';

import '../../audio/sfx.dart';
import '../../ui/pro/pro.dart';
import 'catalog_page.dart';

class SoundsShelf extends StatefulWidget {
  const SoundsShelf({super.key, this.tabs});
  final Widget? tabs;

  @override
  State<SoundsShelf> createState() => _SoundsShelfState();
}

class _SoundsShelfState extends State<SoundsShelf> {
  String _query = '';

  bool _matches(String group, String name) {
    final q = _query.trim().toLowerCase();
    return q.isEmpty || [group, name, soundLabel[name] ?? ''].any((w) => w.toLowerCase().contains(q));
  }

  @override
  Widget build(BuildContext context) {
    final mono = ProText.mono.copyWith(fontSize: 12.5);
    return shelfLayout(
      context,
      left: ShelfColumn(
        tabs: widget.tabs,
        below: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
            child: const Text('农场里的每个声音，点一下就能听。', style: ProText.meta),
          ),
        ],
      ),
      body: [
        ShelfSearch(query: _query, onChanged: (v) => setState(() => _query = v), placeholder: '找：声音的名字或分组（浇水、院子、coin……）'),
        ProCard(
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
            style: ProText.sm.copyWith(color: ProColor.muted),
          ),
        ),
        for (final g in soundGroups)
          if ([
                for (final name in g.names)
                  if (_matches(g.title, name)) name,
              ]
              case final names when names.isNotEmpty)
            ProCard(
              title: g.title,
              child: Wrap(spacing: 8, runSpacing: 8, children: [for (final name in names) _SoundButton(name: name)]),
            ),
      ],
    );
  }
}

class _SoundButton extends StatelessWidget {
  const _SoundButton({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) => Tappable(
    onTap: () => Sfx.play(name),
    semanticLabel: '播放 ${soundLabel[name] ?? name}',
    builder: (context, s) => ProFocusRing(
      on: s.focused,
      child: Container(
        height: 32,
        padding: const EdgeInsets.fromLTRB(6, 0, 12, 0),
        decoration: BoxDecoration(
          color: s.pressed
              ? ProColor.selected
              : s.hovered
              ? ProColor.hover
              : ProColor.page,
          border: Border.all(color: ProColor.line),
          borderRadius: proRadius,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SpriteIcon('button-play', size: 16),
            const SizedBox(width: 8),
            Text(soundLabel[name] ?? name, style: ProText.sm.copyWith(fontWeight: FontWeight.w500)),
            const SizedBox(width: 8),
            Text(name, style: ProText.mono.copyWith(fontSize: 12, color: ProColor.muted)),
          ],
        ),
      ),
    ),
  );
}
