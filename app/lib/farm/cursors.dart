// Flutter has no image cursors, so the system's is hidden over the village and the picture is drawn at the pointer; without the pictures in the bundle the
// system's nearest cursor stands in.

import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/tools.dart';

const cursorDir = 'assets/cursors';

/// From the top left, in 1x pixels; null when the pictures are not bundled.
final cursorHotspotsProvider = FutureProvider<Map<String, Offset>?>((ref) async {
  try {
    final json = jsonDecode(await rootBundle.loadString('$cursorDir/cursors.json')) as Map<String, dynamic>;
    return {for (final MapEntry(:key, :value) in json.entries) key: Offset(((value as Map)['hx'] as num).toDouble(), (value['hy'] as num).toDouble())};
  } on Object {
    return null;
  }
});

String stageCursor({required Tool tool, required Aim? aim, required bool overSpot, required bool pressed}) {
  final name = tool.name;
  if (aim == null) return overSpot ? 'hand-point' : name;
  if (!aim.ok) return '$name-no';
  if (tool == Tool.hand) return pressed ? 'hand-press' : 'hand-point';
  return pressed ? '$name-press' : '$name-ok';
}

MouseCursor systemCursorOf(String name) => name.startsWith('hand') ? SystemMouseCursors.click : SystemMouseCursors.precise;

class CursorPicture extends StatelessWidget {
  const CursorPicture({super.key, required this.name, required this.at, required this.hotspot});
  final String name;
  final Offset at;
  final Offset hotspot;

  @override
  Widget build(BuildContext context) => Positioned(
    left: at.dx - hotspot.dx,
    top: at.dy - hotspot.dy,
    child: IgnorePointer(
      child: Image.asset('$cursorDir/$name@2x.png', scale: 2, filterQuality: FilterQuality.none, gaplessPlayback: true, excludeFromSemantics: true),
    ),
  );
}
