import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/rules/runtimes.dart';

import '../support/workbench.dart';

void main() {
  test('what a runtime takes is what runtime.list says of it', () {
    final pi = runtime('pi', available: false, refused: const {sessionEnv: 'adapter refuses isolated environment'});
    expect(factsOf(pi).refused[sessionEnv], 'adapter refuses isolated environment');
    expect(factsOf(pi).inProcess, isTrue);
    expect(factsOf(null).refused, isEmpty);
    expect(factsOf(null).capabilities, isEmpty);
    expect(factsOf(null).steer, isFalse);
  });

  test('runtimeName reads the catalog and falls back to the id', () {
    final catalog = [runtime('claude'), runtime('pi')];
    expect(runtimeName(catalog, 'claude'), 'Claude Code');
    expect(runtimeName(catalog, 'pi'), 'Pi');
    expect(runtimeName(catalog, 'mystery'), 'mystery');
    expect(runtimeName(const [], 'claude'), 'claude');
    expect(runtimeOf(catalog, 'pi')?.preset.label, 'Pi');
  });
}
