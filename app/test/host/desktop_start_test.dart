@TestOn('mac-os')
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';

import '../support/desktop_start.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  test('two host starts share the pending server, and quitting before readiness releases it', () async {
    final root = await Directory.systemTemp.createTemp('vibevalley-host-start-');
    addTearDown(() => root.delete(recursive: true));
    final calls = nativeCalls(binding);
    final shell = await script(root, 'path-shell', '#!/bin/sh\nprintf "__VIBEVALLEY_PATH__%s__VIBEVALLEY_PATH__" "\$PATH"\n');
    final binary = await script(root, 'farm', '#!/bin/sh\necho start >> "${root.path}/starts"\necho \$\$ > "${root.path}/child.pid"\nexec sleep 30\n');
    final env = environment(root, binary, shell);
    final first = startDesktop(environment: env);
    final second = startDesktop(environment: env);
    final pidFile = File('${root.path}/child.pid');
    await waitForFile(pidFile);
    final pid = int.parse(await pidFile.readAsString());
    expect(alive(pid), isTrue);
    await quitDesktop();
    await Future.wait([first, second]);
    expect(await File('${root.path}/starts').readAsLines(), ['start']);
    expect(alive(pid), isFalse);
    expect(calls, isNot(contains('fatal')));
    expect(calls, isNot(contains('server')));
  });
}
