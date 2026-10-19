import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/data/server_choice.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('returning to the local farm preserves its address and the paired remote', () async {
    SharedPreferences.setMockInitialValues({});
    final previous = serverConnection.value;
    addTearDown(() => serverConnection.value = previous);
    final remote = RemoteServer(url: Uri.parse('http://farm.test'), key: 'test-key', hostName: 'farm', device: 'device');
    serverConnection.value = ServerConnection(
      choice: ServerChoice(remote: remote, useRemote: true),
      localAddress: 'http://127.0.0.1:12345',
    );
    await useLocalFarm();
    expect(serverConnection.value.remote, isNull);
    expect(serverConnection.value.choice.remote, same(remote));
    expect(serverConnection.value.localAddress, 'http://127.0.0.1:12345');
    await loadServerChoice();
    expect(serverConnection.value.choice.remote?.key, 'test-key');
    expect(serverConnection.value.choice.useRemote, isFalse);
  });

  test('the home and the work folder', () {
    expect(desktopHome({'HOME': '/u'}), '/u/Library/Application Support/vibevalley');
    expect(desktopHome({'HOME': '/u', 'VIBEVALLEY_HOME': '/h'}), '/h');
    expect(desktopWorkRoot({'HOME': '/u'}), '/u/vibevalley');
    expect(DesktopChannel.beta.workFolder, 'vibevalley-beta');
    expect(desktopWorkRoot({'HOME': '/u', 'VIBEVALLEY_WORK_ROOT': '/w'}), '/w');
  });
}
