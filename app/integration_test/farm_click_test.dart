// Clicks on the village reach it in the whole app: the frame's overlays above the farm (the toasts' column, the debug
// console, the server-away banner) let them through, and the manager opens its panel. Needs a server: flutter test integration_test/farm_click_test.dart -d macos --dart-define=VIBEVALLEY_SERVER=…

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/app/app.dart';
import 'package:vibevalley/data/ui_state.dart';
import 'package:vibevalley/game/destinations.dart';
import 'package:vibevalley/village/village_view.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('a click on the manager in the village opens its panel', (tester) async {
    final key = GlobalKey();
    await tester.pumpWidget(
      ProviderScope(
        child: KeyedSubtree(key: key, child: const VibeValleyApp()),
      ),
    );
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final container = ProviderScope.containerOf(key.currentContext!);
    container.read(titleOpenProvider.notifier).enterFarm(start: false);
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    final village = container.read(villageProvider).value!;
    final canvas = tester.getRect(find.byType(VillageCanvas));
    final scale = canvas.width / village.width;
    final b = village.spotBoxes[YardPlace.manager]!;
    final at = canvas.topLeft + Offset((b.x0 + b.x1) / 2 * scale, (b.y0 + b.y1) / 2 * scale);
    await tester.tapAt(at);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(container.read(panelProvider), FarmPanel.manager);
    // The click's sound plays out before the app goes.
    await tester.pumpWidget(const SizedBox());
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  });
}
