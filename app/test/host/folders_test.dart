import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/data/farm_choice.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('returning to the local farm preserves its address and the paired remote', () async {
    SharedPreferences.setMockInitialValues({});
    final previous = farmConnection.value;
    addTearDown(() => farmConnection.value = previous);
    final remote = RemoteFarm(url: Uri.parse('http://farm.test'), key: 'test-key', farm: 'farm', device: 'device');
    farmConnection.value = FarmConnection(
      choice: FarmChoice(remote: remote, useRemote: true),
      localAddress: 'http://127.0.0.1:12345',
    );
    await useLocalFarm();
    expect(farmConnection.value.remote, isNull);
    expect(farmConnection.value.choice.remote, same(remote));
    expect(farmConnection.value.localAddress, 'http://127.0.0.1:12345');
    await loadFarmChoice();
    expect(farmConnection.value.choice.remote?.key, 'test-key');
    expect(farmConnection.value.choice.useRemote, isFalse);
  });

  test('the home and the work folder', () {
    expect(desktopHome({'HOME': '/u'}), '/u/Library/Application Support/vibevalley');
    expect(desktopHome({'HOME': '/u', 'VIBEVALLEY_HOME': '/h'}), '/h');
    expect(desktopWorkRoot({'HOME': '/u'}), '/u/vibevalley-work');
    expect(desktopWorkRoot({'HOME': '/u', 'VIBEVALLEY_WORK_ROOT': '/w'}), '/w');
  });
}
