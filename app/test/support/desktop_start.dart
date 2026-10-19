import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/server_choice.dart';

Future<File> script(Directory root, String name, String body) async {
  final file = File('${root.path}/$name');
  await file.writeAsString(body);
  await Process.run('chmod', ['+x', file.path]);
  return file;
}

Future<void> waitForFile(File file) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!await file.exists()) {
    if (DateTime.now().isAfter(deadline)) fail('child did not enter ${file.path}');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

bool alive(int pid) => Process.runSync('kill', ['-0', '$pid']).exitCode == 0;

Map<String, String> environment(Directory root, File binary, File shell) => {
  'PATH': Platform.environment['PATH'] ?? '/usr/bin:/bin',
  'HOME': root.path,
  'SHELL': shell.path,
  'VIBEVALLEY_HOME': '${root.path}/home',
  'VIBEVALLEY_WORK_ROOT': '${root.path}/work',
  'VIBEVALLEY_SERVER_BIN': binary.path,
};

List<String> nativeCalls(TestWidgetsFlutterBinding binding) {
  serverConnection.value = const ServerConnection(choice: ServerChoice());
  final calls = <String>[];
  const channel = MethodChannel('vibevalley/desktop');
  binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
    calls.add(call.method);
    return null;
  });
  addTearDown(() => binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
  return calls;
}

Future<void> quitDesktop() {
  final done = Completer<void>();
  const codec = StandardMethodCodec();
  ServicesBinding.instance.channelBuffers.push('vibevalley/desktop', codec.encodeMethodCall(const MethodCall('quit')), (reply) {
    try {
      if (reply != null) codec.decodeEnvelope(reply);
      done.complete();
    } on Object catch (error, stack) {
      done.completeError(error, stack);
    }
  });
  return done.future;
}
