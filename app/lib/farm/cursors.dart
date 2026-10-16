// The farm's mouse cursors over the village (web/src/farm/cursors.tsx and PixelFarm.tsx useStageCursor): the tool in
// hand, with a sparkle where it would work, a "no" sign where it would not, tilted while pressed; a pointing glove
// over a thing in the yard. The pictures are design/pixel's (web/src/pixel/cursors, each with its hotspot in
// cursors.json). Flutter has no image cursors, so the system's is hidden over the village and the picture is drawn at
// the pointer; without the pictures in the bundle (assets/cursors) the system's nearest cursor stands in, as the web
// page's CSS fallback does.

import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../game/farm.dart';

/// Where the cursor pictures are in the bundle.
const cursorDir = 'assets/cursors';

/// Each cursor's hotspot (from the top left, in 1x pixels); null when the pictures are not bundled.
final cursorHotspotsProvider = FutureProvider<Map<String, Offset>?>((ref) async {
  try {
    final json = jsonDecode(await rootBundle.loadString('$cursorDir/cursors.json')) as Map<String, dynamic>;
    return {for (final MapEntry(:key, :value) in json.entries) key: Offset(((value as Map)['hx'] as num).toDouble(), (value['hy'] as num).toDouble())};
  } on Object {
    return null;
  }
});

/// The stage's cursor, by name (useStageCursor): over a bed, the tool and whether it works there; over a thing in
/// the yard, the pointing glove; elsewhere, the tool in hand.
String stageCursor({required Tool tool, required Aim? aim, required bool overSpot, required bool pressed}) {
  final name = tool.name;
  if (aim == null) return overSpot ? 'hand-point' : name;
  if (!aim.ok) return '$name-no';
  if (tool == Tool.hand) return pressed ? 'hand-press' : 'hand-point';
  return pressed ? '$name-press' : '$name-ok';
}

/// The system cursor standing in for a picture (cursors.tsx fallbacks: a pointer for the glove, a crosshair for tools).
MouseCursor systemCursorOf(String name) => name.startsWith('hand') ? SystemMouseCursors.click : SystemMouseCursors.precise;

/// The cursor picture at `at` (the pointer, in this widget's coordinates), its hotspot on the point.
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
