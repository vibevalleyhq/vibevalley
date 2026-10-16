// The phone's notifications: what tapping one opens reaches the screens as a command, even when the tap launched the
// app before any screen listened.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desktop/command.dart';
import 'package:vibevalley/mobile/notices.dart';

void main() {
  test('a tap waits for a screen, then opens what the notification was about', () async {
    final notices = PhoneNotices.instance;
    notices.open(jsonEncode(const DesktopOpenWorker('w3').toJson()));
    final got = <DesktopCommand>[];
    final sub = notices.commands.listen(got.add);
    await Future<void>.delayed(Duration.zero);
    notices.open(jsonEncode(const DesktopOpenAchievements().toJson()));
    notices.open('');
    notices.open('not json');
    await Future<void>.delayed(Duration.zero);
    await sub.cancel();
    expect(got.map((c) => c.toJson()), [
      {'type': 'worker', 'id': 'w3'},
      {'type': 'achievements'},
    ]);
  });
}
