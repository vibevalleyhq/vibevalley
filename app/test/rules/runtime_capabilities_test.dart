import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/seeds.dart';

void main() {
  test('configuration constraints use the server observation without mutating seeded presentation', () {
    const runtime = RuntimeInfo(
      id: 'pi',
      installation: InstallationNotFound(),
      settings: RuntimeSettings(enabled: true, binPath: '', defaultModel: '', defaultEffort: '', env: {}),
      checkedAt: 0,
      refused: {sessionEnv: 'adapter refuses isolated environment'},
    );
    expect(factsOf('pi', runtime).refused[sessionEnv], 'adapter refuses isolated environment');
    expect(factsOf('pi').refused[sessionEnv], isNull);
    expect(factsOf('pi', runtime).steer, factsOf('pi').steer);
  });
}
