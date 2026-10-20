import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/ui/pixel/pixel.dart';

void main() {
  group('markdown parsing', () {
    test('blocks: headings, lists with tasks, code, quotes, rules, tables, setext', () {
      final blocks = parseMarkdown('''
# 标题

一段 **粗** 话
接着一行

- [x] 做完
- [ ] 没做
  - 嵌套

1. 一
2. 二

```dart
var a = 1;
```

> 引用

---

| 名 | 数 |
|:--|--:|
| a | 1 |

小标题
---
''');
      expect(blocks.map((b) => b.runtimeType.toString()), [
        'MdHeading',
        'MdParagraph',
        'MdList',
        'MdList',
        'MdCode',
        'MdQuote',
        'MdRule',
        'MdTable',
        'MdHeading',
      ]);
      final graphs = blocks[2] as MdList;
      expect(graphs.items.map((i) => i.checked), [true, false]);
      expect(graphs.items[1].children.last, isA<MdList>());
      expect((blocks[3] as MdList).ordered, isTrue);
      expect((blocks[4] as MdCode).text, 'var a = 1;');
      expect((blocks[4] as MdCode).lang, 'dart');
      final table = blocks[7] as MdTable;
      expect(table.aligns, [MdAlign.left, MdAlign.right]);
      expect(table.rows, [
        ['a', '1'],
      ]);
      expect((blocks[8] as MdHeading).level, 2);
    });

    test('inlines: code, emphasis, strike, links, bare URLs, escapes', () {
      final inl = parseInline(r'看 `x*y` 和 **粗 *斜* 的** ~~删~~ [链](https://a.b/c) 去 https://x.y/z. 还有 \*星\*');
      final kinds = inl.map((n) => n.runtimeType.toString()).toList();
      expect(kinds, containsAllInOrder(['MdCodeSpan', 'MdStyled', 'MdStyled', 'MdLink', 'MdLink']));
      expect((inl.whereType<MdLink>().first).href, 'https://a.b/c');
      expect((inl.whereType<MdLink>().last).href, 'https://x.y/z');
      expect(inl.whereType<MdText>().last.text, endsWith('*星*'));
    });

    test('a soft break is a space, two spaces a line break', () {
      expect(parseInline('a\nb').whereType<MdText>().map((t) => t.text).join(), 'a b');
      expect(parseInline('a  \nb').whereType<MdBreak>(), hasLength(1));
    });
  });

  test('withMentions links @names outside code only', () {
    expect(withMentions('叫 @w3 和 @管家，`@w4` 不算，a@w5 也不算'), '叫 [@w3](#mention) 和 [@管家](#mention)，`@w4` 不算，a@w5 也不算');
  });

  test('plainText flattens markdown to one line', () {
    expect(plainText('# 标题\n- **一** 项\n`code` [链](http://x)\n```\nblock\n```'), '标题 一 项 code 链');
  });

  group('PxMarkdown', () {
    testWidgets('draws text, a mention chip and an openable link', (t) async {
      Uri? opened;
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(body: PxMarkdown('你好 @管家，看 [这里](https://example.com)\n\n- 一\n- 二', mentions: true, onOpenLink: (u) => opened = u)),
        ),
      );
      expect(find.textContaining('你好'), findsOneWidget);
      expect(find.text('@管家', findRichText: true), findsOneWidget);
      expect(find.textContaining('二'), findsOneWidget);
      await t.tap(find.textContaining('这里', findRichText: true));
      // The link is a span inside the paragraph: tap the span through its recognizer.
      final rich = t.widget<RichText>(find.textContaining('这里', findRichText: true).first);
      var tapped = false;
      rich.text.visitChildren((span) {
        if (span is TextSpan && span.text == '这里' && span.recognizer != null) {
          (span.recognizer! as dynamic).onTap();
          tapped = true;
        }
        return true;
      });
      expect(tapped, isTrue);
      expect(opened, Uri.parse('https://example.com'));
    });

    testWidgets('code blocks and tables render', (t) async {
      await t.pumpWidget(const MaterialApp(home: Scaffold(body: PxMarkdown('```\nlet x\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'))));
      expect(find.text('let x'), findsOneWidget);
      expect(find.byType(Table), findsOneWidget);
    });
  });

  group('labels', () {
    test('every phase has its word', () {
      expect(phaseLabel(const PhaseRipe()), '完工');
      expect(managerLabel[ManagerState.listening], '在听');
      expect(outcomeLabel[Outcome.interrupted], '叫停');
    });

    test('ago', () {
      expect(ago(0, 4000), '刚刚');
      expect(ago(0, 30000), '30 秒前');
      expect(ago(0, 150000), '3 分钟前');
      expect(ago(0, 262 * 60000), '4 小时前');
      expect(ago(0, 50 * 3600000), '2 天前');
      expect(ago(10000, 0), '刚刚');
    });
  });

  group('quota', () {
    test('quotaOf and the bottle', () {
      // What is left and the words are the server's (RuntimeInfo.quota); the bottle is the client's.
      RuntimeInfo at(AccountUsage? usage, {double? left, String text = ''}) => RuntimeInfo(
        id: 'x',
        preset: const RuntimePreset(
          id: 'x',
          label: 'x',
          blurb: '',
          look: Look(build: Build.biped, head: Head.rounded, body: '#fff', trim: '#000', hat: '#f00', eye: '#0ff'),
        ),
        facts: const RuntimeFacts(steer: false, refused: {}, capabilities: [], inProcess: false),
        installation: const InstallationNotFound(),
        usage: usage,
        settings: RuntimeSettings.fromJson(const {'enabled': true, 'binPath': '', 'defaultModel': '', 'defaultEffort': '', 'env': <String, String>{}}),
        quota: RuntimeQuota(left: left, text: text),
        checkedAt: 0,
      );
      final plenty = quotaOf(
        at(
          const AccountUsageOk(windows: [UsageWindow(label: 'w', usedPercent: 11)]),
          left: 89,
          text: 'w 剩 89%',
        ),
      );
      expect((plenty.level, plenty.short, plenty.text, bottleSprite(plenty)), (QuotaLevel.plenty, '89%', 'w 剩 89%', 'energy-plenty-100'));
      final low = quotaOf(at(const AccountUsageOk(windows: [UsageWindow(label: 'w', usedPercent: 70)]), left: 30));
      expect((low.level, bottleSprite(low)), (QuotaLevel.low, 'energy-low-25'));
      final empty = quotaOf(at(const AccountUsageLoginRequired(), text: '没登录'));
      expect((empty.level, empty.short, bottleSprite(empty)), (QuotaLevel.empty, '没登录', 'energy-empty-0'));
      final gold = quotaOf(
        at(
          const AccountUsageBalance(
            provider: 'p',
            available: true,
            balances: [Balance(currency: 'USD', amount: 2)],
          ),
        ),
      );
      expect((gold.level, gold.short), (QuotaLevel.gold, r'$2.00'));
      expect(quotaOf(null).level, QuotaLevel.unknown);
      expect(StaminaBar.litOf(const Quota(level: QuotaLevel.low, fill: .01, short: '', text: ''), 10), 1);
    });

    test('windowLabel', () {
      expect(windowLabel('Current session'), '当前会话');
      expect(windowLabel('Current week (all models)'), '本周（全部模型）');
      expect(windowLabel('Current week (Opus)'), '本周（Opus）');
      expect(windowLabel('Codex · 1 week'), 'Codex · 一周');
    });
  });
}
