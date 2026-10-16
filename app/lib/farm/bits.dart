import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../desk/shared/faces.dart' as desk show AgentFace;
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart' show agentsProvider;
import '../rules/playbook.dart';

class FarmEmpty extends StatelessWidget {
  const FarmEmpty(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    color: Palette.cream100,
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 32),
    alignment: Alignment.center,
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: KitText.sm.copyWith(color: Palette.bark600),
    ),
  );
}

class FarmTag extends StatelessWidget {
  const FarmTag(this.text, {super.key, this.fill = Palette.cream200, this.ink = Palette.bark800, this.icon, this.goes = false});
  final String text;
  final Color fill;
  final Color ink;

  final String? icon;

  final bool goes;

  @override
  Widget build(BuildContext context) => Container(
    color: fill,
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (icon != null) ...[SpriteIcon(icon!, size: 12), const SizedBox(width: 4)],
        Text(text, maxLines: 1, style: KitText.xs.copyWith(color: ink)),
        if (goes) ...[const SizedBox(width: 4), const SpriteIcon('button-next', size: 10)],
      ],
    ),
  );
}

class Tinted extends StatelessWidget {
  const Tinted({super.key, required this.child, this.color = Palette.cream100, this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 8)});
  final Widget child;
  final Color color;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(color: color, padding: padding, child: child);
}

class Said extends StatelessWidget {
  const Said(this.answer, {super.key});
  final Answer? answer;

  @override
  Widget build(BuildContext context) {
    final a = answer;
    if (a == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(a.text, style: KitText.xs.copyWith(color: a.ok ? Palette.leaf700 : Palette.berry)),
    );
  }
}

/// In epoch milliseconds.
class Ticking extends StatefulWidget {
  const Ticking({super.key, required this.builder});
  final Widget Function(BuildContext context, double now) builder;

  @override
  State<Ticking> createState() => _TickingState();
}

class _TickingState extends State<Ticking> {
  late final Timer _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, DateTime.now().millisecondsSinceEpoch.toDouble());
}

class AgentFace extends ConsumerWidget {
  const AgentFace(this.agentId, {super.key, required this.size, this.muted = false});
  final String agentId;
  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final agent = (ref.watch(agentsProvider).value ?? const <String, AgentProfile>{})[agentId];
    return desk.AgentFace(look: agent?.look, id: agentId, size: size, muted: muted);
  }
}

class ManagerFaceOf extends ConsumerWidget {
  const ManagerFaceOf({super.key, required this.size, required this.look});
  final double size;
  final String look;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final SpriteAtlas? atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    final name = look != 'farmer' && atlas.has('manager-$look-face') ? 'manager-$look-face' : 'manager-face';
    return ManagerFace(atlas: atlas, size: size, look: name);
  }
}

String clockOf(double at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.round());
  return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

/// A colour at a share of its strength over cream.
Color tint(Color c, double alpha) => Color.alphaBlend(c.withValues(alpha: alpha), Palette.cream50);
