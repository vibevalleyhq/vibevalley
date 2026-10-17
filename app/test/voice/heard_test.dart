import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/voice/captions.dart';

void main() {
  test('a finished sentence of yours is heard once; partial ones and the manager are not', () {
    final heard = <String>[];
    final captions = LiveCaptions()..onHeard = heard.add;
    captions.apply({'object': 'user.transcription', 'turn_id': 1, 'text': '让小禾', 'final': false});
    captions.apply({'object': 'user.transcription', 'turn_id': 1, 'text': '让小禾写测试', 'final': true});
    captions.apply({'object': 'user.transcription', 'turn_id': 1, 'text': '让小禾写测试', 'final': true});
    captions.apply({'object': 'assistant.transcription', 'turn_id': 1, 'text': '好的', 'turn_status': 1});
    captions.apply({'object': 'user.transcription', 'turn_id': 2, 'text': '  ', 'final': true});
    captions.apply({'object': 'user.transcription', 'turn_id': 3, 'text': '再跑一遍', 'turn_status': 1});
    expect(heard, ['让小禾写测试', '再跑一遍']);
    captions.clear();
    captions.apply({'object': 'user.transcription', 'turn_id': 1, 'text': '新的一通', 'final': true});
    expect(heard.last, '新的一通');
  });
}
