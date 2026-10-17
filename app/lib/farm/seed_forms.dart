import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/remote.dart' show projectNamesProvider;
import '../game/commands.dart';
import '../game/farm.dart';
import '../gen/vibevalley.dart';
import '../shell/prefs.dart';
import '../shell/sfx.dart';
import '../ui/kit/kit.dart';
import '../data/remote.dart' show agentsProvider;
import '../rules/warehouse.dart';
import '../shared/faces.dart';
import '../shared/tags.dart';

class SeedForm extends ConsumerStatefulWidget {
  const SeedForm({super.key, required this.station, required this.onDone});
  final int station;
  final VoidCallback onDone;

  @override
  ConsumerState<SeedForm> createState() => _SeedFormState();
}

class _SeedFormState extends ConsumerState<SeedForm> {
  String? _who;
  var _text = '';

  @override
  Widget build(BuildContext context) {
    final agents = (ref.watch(agentsProvider).value ?? const <String, Agent>{}).values.where((a) => a.enabled).toList();
    final pick = ref.watch(prefsProvider.select((p) => p.pick));
    final who = _who ?? (agents.any((a) => a.id == pick) ? pick : 'auto');
    final asked = askedOf(ref.watch(farmProvider));
    final seeds = seedsFor(asked, ref.watch(projectNamesProvider).value ?? const []);
    void sow() {
      if (_text.trim().isEmpty) return;
      Sfx.play('plant');
      fire(ref.read(farmCommandsProvider).plant(widget.station, _text, who == 'auto' ? null : who));
      widget.onDone();
    }

    final label = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('种子（工单）', style: label),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final s in seeds)
              KitTappable(
                onTap: () => setState(() => _text = s),
                selected: _text == s,
                builder: (context, st) => Container(
                  color: _text == s ? Palette.leaf500 : (st.hovered ? Palette.cream300 : Palette.cream200),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Text(s, style: KitText.xs.copyWith(color: _text == s ? Palette.cream50 : Palette.bark800)),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        PxTextArea(value: _text, onChanged: (v) => setState(() => _text = v), rows: 3, placeholder: '或者自己写：要做什么，做到什么程度', semanticLabel: '工单'),
        const SizedBox(height: 12),
        Text('谁来种', style: label),
        const SizedBox(height: 6),
        Semantics(
          label: '谁来种',
          child: Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              _WhoTile(
                active: who == 'auto',
                label: '管家挑',
                onTap: () => setState(() => _who = 'auto'),
                child: Container(
                  width: 44,
                  height: 44,
                  color: Palette.cream200,
                  alignment: Alignment.center,
                  child: Text('?', style: KitText.lg.copyWith(color: Palette.bark600)),
                ),
              ),
              for (final a in agents)
                _WhoTile(active: who == a.id, label: a.name, onTap: () => setState(() => _who = a.id), child: AgentFaceOf(a.id, size: 44)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(child: Text('管家会把这句话交给帮工；没开工的话会先开工。', style: label)),
            const SizedBox(width: 8),
            PxButton.text('播种', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : sow),
          ],
        ),
      ],
    );
  }
}

class _WhoTile extends StatelessWidget {
  const _WhoTile({required this.active, required this.label, required this.onTap, required this.child});
  final bool active;
  final String label;
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    selected: active,
    semanticLabel: label,
    builder: (context, s) => Container(
      width: 64,
      color: active ? tint(Palette.leaf300, .7) : (s.hovered ? Palette.cream200 : null),
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          child,
          const SizedBox(height: 2),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: KitText.xs.copyWith(color: Palette.bark800),
          ),
        ],
      ),
    ),
  );
}

const _dropsOfAdvice = ['改动小一点', '先别动测试', '做完跟我说一声', '顺便补个测试'];

class WaterForm extends ConsumerStatefulWidget {
  const WaterForm({super.key, required this.worker, required this.onDone});
  final Worker worker;
  final VoidCallback onDone;

  @override
  ConsumerState<WaterForm> createState() => _WaterFormState();
}

class _WaterFormState extends ConsumerState<WaterForm> {
  var _text = '';

  void _send() {
    if (_text.trim().isEmpty) return;
    fire(ref.read(farmCommandsProvider).water(widget.worker, _text));
    widget.onDone();
  }

  @override
  Widget build(BuildContext context) {
    final w = widget.worker;
    final xs = KitText.xs.copyWith(color: Palette.bark600);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(w.phase is PhaseWorking ? '它正在干活，这句话会在下一步之前收到。' : '它现在没在干活，这句话会让它接着干一轮。', style: KitText.sm.copyWith(color: Palette.bark800)),
        const SizedBox(height: 4),
        Text('这句话记在它的工单串里，它回的话也在那儿。', style: xs),
        const SizedBox(height: 4),
        Text('现在的活：${w.task}', style: xs),
        const SizedBox(height: 12),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final s in _dropsOfAdvice)
              KitTappable(
                onTap: () => setState(() => _text = s),
                builder: (context, st) => Container(
                  color: st.hovered ? Palette.cream300 : Palette.cream200,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: Text(s, style: KitText.xs.copyWith(color: Palette.bark800)),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        PxTextInput(
          value: _text,
          onChanged: (v) => setState(() => _text = v),
          onSubmitted: (_) => _send(),
          autofocus: true,
          placeholder: '带句话……',
          semanticLabel: '给${w.name}带句话',
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerRight,
          child: PxButton.text('浇水', tone: PxTone.primary, onPressed: _text.trim().isEmpty ? null : _send),
        ),
      ],
    );
  }
}
