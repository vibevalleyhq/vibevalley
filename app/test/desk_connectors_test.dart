import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/connectors/connectors_page.dart';
import 'package:vibevalley/desk/connectors/qr.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'support/desk.dart';
import 'package:vibevalley/rules/chat.dart';

// What the qrcode package (1.5.4) draws for QRCode.create([{ data, mode: 'byte' }], { errorCorrectionLevel: 'M' }).
const _hello = [
  '111111101101001111111',
  '100000100110101000001',
  '101110100111101011101',
  '101110101001001011101',
  '101110101000101011101',
  '100000101011001000001',
  '111111101010101111111',
  '000000001111100000000',
  '100010111111011111001',
  '000111001011100101111',
  '101100101011001110010',
  '111001000100011010000',
  '001011100100111000110',
  '000000001110111001011',
  '111111101100110001010',
  '100000100001100100010',
  '101110101001001110101',
  '101110100001100001011',
  '101110100111001111000',
  '100000100100011000000',
  '111111101000111110101',
];
const _weixin = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d&bot_type=3';
const _weixinRows = [
  '11111110001110100111111111001001001111111',
  '10000010001000110100110001110110001000001',
  '10111010111001101110111011010001001011101',
  '10111010111111100000110000111010101011101',
  '10111010111111001011001110001110101011101',
  '10000010101000001010010000011000101000001',
  '11111110101010101010101010101010101111111',
  '00000000100100100001011000010010000000000',
  '10111110010100110100101011111101001111100',
  '10000101000110100001101100101011101010101',
  '11000111011110011110011001011010111000000',
  '01101001110011101011111000010001100111001',
  '00001111000011000101100011111101100001101',
  '11111101001110100010011000010101001011101',
  '10001010111100011000100110111010110111110',
  '00111001100110100010011100110010101011010',
  '11111010011101100110101111011101010100100',
  '10101001011000010011000100100111101111011',
  '11000110010101111010101010010100101010000',
  '11010000101111000001000110111111101011001',
  '10101010100001000010011010011000010100110',
  '01000101101100100001100100101111101111011',
  '01101010100101100010110010011010100010000',
  '00010001100011101000010000001001111111000',
  '11111111111100001110001011000100000001011',
  '11100000000101011011010100001001011111011',
  '01100011011000100110010001011000110110000',
  '10100101101001111001110100111001110111011',
  '01111011101100101111001001110111100101110',
  '11011100001001110000110010011001011111111',
  '10111110000100100101000000000110111101000',
  '10101001001100110011110010101000111100001',
  '10100111000111101101000001100110111110110',
  '00000000100011000111111111001001100011011',
  '11111110011010001100010011111011101011000',
  '10000010110000010110111101010000100010011',
  '10111010111100001000110010101010111111101',
  '10111010110010001111001101000001010101100',
  '10111010100101111000110001111000011111100',
  '10000010011010100010011100010010000011010',
  '11111110100101111000001101110101001111100',
];

List<String> rowsOf(QrCode q) => [
  for (var y = 0; y < q.size; y++) [for (var x = 0; x < q.size; x++) q.dark(x, y) ? '1' : '0'].join(),
];

Map<String, dynamic> status(String id, String state, {Map<String, dynamic> more = const {}}) => {'id': id, 'state': state, 'pending': 0, ...more};

Routes backend(List<Map<String, dynamic>> list, {Map<String, Object? Function(Call)> more = const {}}) => Routes({'GET /api/v1/connectors': (_) => list, ...more});

void main() {
  group('QR encoder', () {
    test('matches the qrcode package', () {
      final hello = QrCode.encode('HELLO');
      expect(hello.version, 1);
      expect(rowsOf(hello), _hello);
      final weixin = QrCode.encode(_weixin);
      expect(weixin.version, 6);
      expect(rowsOf(weixin), _weixinRows);
    });

    test('grows its version with the text and refuses what does not fit', () {
      expect(QrCode.encode('x' * 300).version, greaterThan(10));
      expect(() => QrCode.encode('x' * 3000), throwsArgumentError);
    });
  });

  test('channelsOf: 田头 first, then the channels by id, no threads', () {
    Conversation c(double id, ConversationKind kind, [String? name]) => Conversation(id: id, kind: kind, name: name, replies: 0, at: 0);
    final chat = Chat(
      conversations: [c(3, ConversationKind.channel, 'b'), c(4, ConversationKind.thread), c(2, ConversationKind.channel, 'a'), c(1, ConversationKind.general)],
      messages: const [],
    );
    expect([for (final x in channelsOf(chat)) x.id], [1, 2, 3]);
  });

  testWidgets('off: the list says how each logs in, and 扫码登录 starts a login', (t) async {
    final b = backend(
      [status('weixin', 'off'), status('feishu', 'connected'), status('qq', 'off')],
      more: {
        'POST /api/v1/connectors/weixin/login': (_) => status('weixin', 'waiting', more: {'qr': _weixin}),
      },
    );
    await pumpPage(t, const ConnectorsPage(), b.handle);
    expect(find.text('扫码登录，私聊机器人'), findsOneWidget);
    expect(find.text('已连接'), findsOneWidget);
    expect(find.text('填 QQ 机器人的 AppID'), findsOneWidget);
    await t.tap(find.text('微信扫码登录'));
    await settle(t);
    expect(b.calls.where((c) => c.method == 'POST' && c.path.endsWith('/login')), hasLength(1));
    expect(find.bySemanticsLabel('微信登录二维码'), findsOneWidget);
    expect(find.text('用手机微信扫这个码。'), findsOneWidget);
    expect(find.byType(QrImage), findsOneWidget);
  });

  testWidgets('QQ takes an AppID and a secret', (t) async {
    final b = backend(
      [status('qq', 'off')],
      more: {
        'POST /api/v1/connectors/qq/login': (_) => status('qq', 'pairing', more: {'pairCode': '1234'}),
      },
    );
    await pumpPage(t, const ConnectorsPage(id: 'qq'), b.handle);
    await t.enterText(find.bySemanticsLabel('AppID').last, '102000');
    await t.enterText(find.bySemanticsLabel('AppSecret').last, 's3cret');
    await t.pump();
    await t.tap(find.text('连接 QQ 机器人'));
    await settle(t);
    final login = b.calls.where((c) => c.path.endsWith('/login')).single;
    expect(login.body, {'appId': '102000', 'secret': 's3cret'});
    expect(find.text('1234'), findsOneWidget);
  });

  testWidgets('connected: the owner, the channel and 断开', (t) async {
    final b = backend([
      status('weixin', 'connected', more: {'owner': 'wx…a1', 'channel': '田头', 'pending': 2}),
    ]);
    await pumpPage(t, const ConnectorsPage(), b.handle);
    expect(find.text('wx…a1'), findsOneWidget);
    expect(find.text('2 条：你下次说话时一起发'), findsOneWidget);
    expect(find.text('还没有'), findsOneWidget);
    expect(find.text('断开'), findsOneWidget);
  });
}
