import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';

void main() {
  test('the home and the work folder', () {
    expect(desktopHome({'HOME': '/u'}), '/u/Library/Application Support/vibevalley');
    expect(desktopHome({'HOME': '/u', 'VIBEVALLEY_HOME': '/h'}), '/h');
    expect(desktopWorkRoot({'HOME': '/u'}), '/u/vibevalley-work');
    expect(desktopWorkRoot({'HOME': '/u', 'VIBEVALLEY_WORK_ROOT': '/w'}), '/w');
  });
}
