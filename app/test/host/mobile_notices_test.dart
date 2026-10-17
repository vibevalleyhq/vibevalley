import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/command.dart';
import 'package:vibevalley/host/mobile_notices.dart';

void main() {
  test('a tap waits for a screen, then opens what the notification was about', () async {
    final notices = PhoneNotices.instance;
    notices.open(jsonEncode(const DesktopOpenSession('w3').toJson()));
    final got = <DesktopCommand>[];
    final sub = notices.commands.listen(got.add);
    await Future<void>.delayed(Duration.zero);
    notices.open(jsonEncode(const DesktopOpenAchievements().toJson()));
    notices.open('');
    notices.open('not json');
    await Future<void>.delayed(Duration.zero);
    await sub.cancel();
    expect(got.map((c) => c.toJson()), [
      {'type': 'session', 'id': 'w3'},
      {'type': 'achievements'},
    ]);
  });
}
