import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/farm/friends.dart';
import 'package:vibevalley/farm/quota.dart' show HudCard;
import 'package:vibevalley/ui/kit/kit.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/farm.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the crew opens as a row of faces, not as tall as the screen', (tester) async {
    final agents = {for (var i = 0; i < 6; i++) 'a$i': agent('a$i', '帮工$i')};
    await pumpFarm(
      tester,
      const Align(alignment: Alignment.bottomLeft, child: FriendsDock(height: 48)),
      overrides: overrides(farm(workers: []), view(), fakeApi(Routes(), {}), agents: agents),
    );
    await tester.tap(find.text('帮工').first);
    await settle(tester);
    final crew = tester.getSize(find.byType(HudCard).last);
    expect(crew.height, lessThan(120), reason: 'the crew card is $crew');
    await tester.tap(find.text('帮工2').first);
    await settle(tester);
    expect(find.text('下一单派它'), findsOneWidget);
    expect(tester.getSize(find.byType(PxWindow).last).height, lessThan(300));
  });
}
