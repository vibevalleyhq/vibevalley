import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/commands.dart';
import '../gen/vibevalley.dart';
import '../shared/composer.dart';
import '../ui/kit/kit.dart';

const _dropsOfAdvice = ['改动小一点', '先别动测试', '做完跟我说一声', '顺便补个测试'];

class WaterForm extends ConsumerStatefulWidget {
  const WaterForm({super.key, required this.session, required this.onDone});
  final Session session;
  final VoidCallback onDone;

  @override
  ConsumerState<WaterForm> createState() => _WaterFormState();
}

class _WaterFormState extends ConsumerState<WaterForm> {
  final _draft = ComposerDraft();

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
  }

  Future<void> _water(String text, String key) async {
    await ref.read(farmCommandsProvider).water(widget.session, text, sendKey: key);
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.session;
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(w.phase is PhaseWorking ? '它正在干活，这句话会在下一步之前收到。' : '它现在没在干活，这句话会让它接着干一轮。', style: KitText.sm.copyWith(color: Palette.bark800)),
        const SizedBox(height: 4),
        Text('这句话记在它的工单串里，它回的话也在那儿。', style: xs),
        const SizedBox(height: 4),
        Text('现在的活：${w.brief}', style: xs),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final s in _dropsOfAdvice)
              KitTappable(
                onTap: () => _draft.text.value = TextEditingValue(
                  text: s,
                  selection: TextSelection.collapsed(offset: s.length),
                ),
                builder: (context, st) => Container(
                  color: st.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Text(s, style: KitText.xs.copyWith(color: Palette.bark800)),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        Composer(
          look: ComposerLook.inline,
          draft: _draft,
          autofocus: true,
          placeholder: '带句话……',
          semanticLabel: '给${w.name}带句话',
          sendLabel: '浇水',
          onSend: _water,
        ),
      ],
    );
  }
}
