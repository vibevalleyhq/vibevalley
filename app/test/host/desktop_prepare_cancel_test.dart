@TestOn('mac-os')
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';

import '../support/desktop_start.dart';

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  test('quit during preparation waits for the shell and never spawns a farm afterwards', () async {
    final root = await Directory.systemTemp.createTemp('vibevalley-host-prepare-');
    addTearDown(() => root.delete(recursive: true));
    final calls = nativeCalls(binding);
    final shell = await script(
      root,
      'slow-path',
      '#!/bin/sh\necho \$\$ > "${root.path}/shell.pid"\nsleep 0.5\nprintf "__VIBEVALLEY_PATH__%s__VIBEVALLEY_PATH__" "\$PATH"\n',
    );
    final binary = await script(root, 'farm', '#!/bin/sh\necho \$\$ > "${root.path}/child.pid"\nexec sleep 30\n');
    final env = environment(root, binary, shell);
    final starting = startDesktop(environment: env);
    final pidFile = File('${root.path}/shell.pid');
    await waitForFile(pidFile);
    final pid = int.parse(await pidFile.readAsString());
    await quitDesktop();
    await starting;
    await startDesktop(environment: env);
    expect(alive(pid), isFalse);
    expect(await File('${root.path}/child.pid').exists(), isFalse);
    expect(calls, isNot(contains('server')));
    expect(calls, isNot(contains('fatal')));
  });
}
