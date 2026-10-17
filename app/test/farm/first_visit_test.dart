import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vibevalley/farm/first_visit.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('the first visit is not seen, the next one is', () async {
    expect(await markNamesSeen(), isFalse);
    expect(await markNamesSeen(), isTrue);
    expect((await SharedPreferences.getInstance()).getString(namesSeenKey), '1');
  });
}
