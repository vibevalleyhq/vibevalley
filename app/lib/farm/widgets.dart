import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../sprites/atlas.dart';
import '../ui/pixel/pixel.dart';
import '../rules/task.dart';

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
      style: PxText.sm.copyWith(color: Palette.bark600),
    ),
  );
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
      child: Text(a.text, style: PxText.xs.copyWith(color: a.ok ? Palette.leaf700 : Palette.berry)),
    );
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

class EmptyNote extends StatelessWidget {
  const EmptyNote(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    color: Palette.cream100,
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    child: Text(text, style: PxText.xs.copyWith(color: Palette.bark500)),
  );
}

class BadgeLabel extends StatelessWidget {
  const BadgeLabel(this.text, {super.key, this.hat = false});
  final String text;

  final bool hat;

  @override
  Widget build(BuildContext context) => Container(
    color: hat ? Palette.leaf300.withValues(alpha: .5) : Palette.cream200,
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    child: Text(text, style: PxText.xs.copyWith(color: hat ? Palette.leaf700 : Palette.bark600)),
  );
}
