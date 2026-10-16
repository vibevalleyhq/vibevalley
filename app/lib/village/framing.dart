// Where the village goes in a window (farm_page.dart): a whole number of screen pixels for each art pixel, so the
// pixels stay square and sharp, and as large as it can be while its edges cut off at most a little of the village:
// 5% of its width on each side, 8% of its height above and below (out there are only the cliff, the treetops and the
// fence, nothing to click). A window of another shape than the village's 3:2 so loses a little of the edges instead
// of showing bars; one it cannot fill that way keeps bars, which the farm screen fills with the village, dimmed.

import 'dart:math' as math;
import 'dart:ui';

/// How much of the village's width may go past each side of the window, and of its height past the top and bottom.
const villageCutAcross = 0.05;
const villageCutDown = 0.08;

/// The village's place in a window: its scale (screen pixels to an art pixel), its box (which may reach past the
/// window), and the part of the window it covers (where the HUD goes).
typedef VillageFraming = ({double scale, Rect box, Rect shown});

/// The largest whole-number scale whose cuts stay within the limits (at least 1), the village centred.
VillageFraming frameVillage(Size window, Size village) {
  var scale = 1;
  final cover = math.max(window.width / village.width, window.height / village.height).ceil();
  for (var s = cover; s >= 1; s--) {
    final w = village.width * s;
    final h = village.height * s;
    if ((w - window.width) / 2 <= w * villageCutAcross && (h - window.height) / 2 <= h * villageCutDown) {
      scale = s;
      break;
    }
  }
  final w = village.width * scale;
  final h = village.height * scale;
  final box = Rect.fromLTWH(((window.width - w) / 2).roundToDouble(), ((window.height - h) / 2).roundToDouble(), w, h);
  return (scale: scale.toDouble(), box: box, shown: box.intersect(Offset.zero & window));
}
