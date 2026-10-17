import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../gen/vibevalley.dart';
import '../../sprites/atlas.dart';
import '../../rules/cast.dart';

class Picture {
  const Picture({required this.name, required this.w, required this.h, required this.ax, required this.ay, this.hx, this.hy, this.sheet});
  final String name;
  final double w;
  final double h;

  final double ax;
  final double ay;

  final double? hx;
  final double? hy;

  /// From the repository's root.
  final String? sheet;

  String get asset => 'assets/pixel/$name.png';
}

class Pictures {
  Pictures(this.all) : _byName = {for (final p in all) p.name: p};
  final List<Picture> all;
  final Map<String, Picture> _byName;

  Picture? operator [](String name) => _byName[name];
  bool has(String name) => _byName.containsKey(name);

  static Pictures parse(String manifest) {
    final raw = jsonDecode(manifest) as Map<String, dynamic>;
    final density = ((raw['map'] as Map<String, dynamic>)['w'] as num) / SpriteAtlas.levelWidth;
    double? art(Map<String, dynamic> m, String k) => m[k] == null ? null : (m[k] as num) / density;
    return Pictures([
      for (final MapEntry(:key, :value) in raw.entries)
        if (value case final Map<String, dynamic> m)
          Picture(
            name: key,
            w: art(m, 'w')!,
            h: art(m, 'h')!,
            ax: art(m, 'ax')!,
            ay: art(m, 'ay')!,
            hx: art(m, 'hx'),
            hy: art(m, 'hy'),
            sheet: m['sheet'] as String?,
          ),
    ]);
  }
}

final picturesProvider = FutureProvider<Pictures>((ref) async => Pictures.parse(await rootBundle.loadString('assets/pixel/sprites.json')));

bool _isHelper(String name) => Species.values.any((s) => name.startsWith('${s.wire}-'));

class Shelf {
  const Shelf(this.id, this.label, this.hint, this.match);
  final String id;
  final String label;
  final String hint;
  final bool Function(String name) match;
}

final shelves = <Shelf>[
  const Shelf('helpers', '帮工', '七种动物、四套衣服：站、走、干活、欢呼、发愁；在建筑前坐、读、敲、修', _isHelper),
  Shelf('manager', '管家', '六种样子，各有说话、听和头像', (n) => n.startsWith('manager-')),
  Shelf('dog', '狗', '睡、醒、伸懒腰、摇尾巴、叫、跳、翻肚皮……', (n) => n.startsWith('dog-')),
  Shelf('plots', '地块', '从空地到熟了，长草、干了、枯了、锁着', (n) => n.startsWith('plot-')),
  Shelf('yard', '院子', '地图、道具、镜头前的草木、小动物', (n) => n == 'map' || n == 'mailbox' || RegExp(r'^(prop-|fg-|critter-)').hasMatch(n)),
  Shelf('map', '地图', '每个项目一座岛，罗盘、云、排队的种子袋、空位的木桩', (n) => RegExp(r'^(island|map)-').hasMatch(n)),
  Shelf('machines', '农机', '每台是一种 runtime', (n) => n.startsWith('machine-')),
  Shelf('icons', '图标', '面板、入口和提示用的', (n) => n.startsWith('icon-')),
  Shelf('acts', '在做什么', '帮工头上的小图标：读、改、跑命令、搜……', (n) => n.startsWith('act-')),
  Shelf('medals', '奖章与成就', '奖章、成就图案、印章、金币', (n) => RegExp(r'^(medal|emblem|stamp|coins|banner)-').hasMatch(n)),
  Shelf('logos', 'Logo', '农机上的 agent、聊天软件、网页和桌面的图标', (n) => RegExp(r'^(logo|connector|app)-').hasMatch(n)),
  Shelf('langs', '语言', '项目页上种了什么', (n) => n.startsWith('lang-')),
  Shelf('ui', '界面', '精力瓶、田头的按钮、日历的格子', (n) => RegExp(r'^(button|energy|day)-').hasMatch(n)),
  Shelf('other', '其他', '没归上类的', (_) => true),
];

String shelfOf(String name) => shelves.firstWhere((s) => s.match(name)).id;

class Group {
  const Group(this.key, this.label, this.pictures);
  final String key;

  final String label;
  final List<Picture> pictures;
}

/// Case-insensitive, runs of digits by their value.
int naturalCompare(String a, String b) {
  final re = RegExp(r'\d+|\D+');
  final pa = re.allMatches(a.toLowerCase()).map((m) => m[0]!).toList();
  final pb = re.allMatches(b.toLowerCase()).map((m) => m[0]!).toList();
  for (var i = 0; i < pa.length && i < pb.length; i++) {
    final x = pa[i];
    final y = pb[i];
    final nx = int.tryParse(x);
    final ny = int.tryParse(y);
    final c = nx != null && ny != null ? nx.compareTo(ny) : x.compareTo(y);
    if (c != 0) return c;
  }
  final byLength = pa.length.compareTo(pb.length);
  return byLength != 0 ? byLength : a.compareTo(b);
}

List<Group> groupsOf(String shelf, List<Picture> pictures) {
  final sorted = [...pictures]..sort((a, b) => naturalCompare(a.name, b.name));
  if (shelf != 'helpers') return sorted.isEmpty ? const [] : [Group(shelf, '', sorted)];
  return [
    for (final species in Species.values)
      for (final outfit in Outfit.values)
        if (sorted.where((p) => p.name.startsWith('${species.wire}-${outfit.wire}-')).toList() case final list when list.isNotEmpty)
          Group('${species.wire}-${outfit.wire}-', '${speciesLabel[species]} · ${outfitLabel[outfit]}', list),
  ];
}

/// The pixel walk has two steps around a standing frame (`x-1`, `x`, `x-2`, `x`).
List<String>? framesOf(String name, bool Function(String) has) {
  final base = RegExp(r'^(.*)-(\d+)$').firstMatch(name)?[1] ?? name;
  final numbered = <String>[];
  for (var n = 1; has('$base-$n'); n++) {
    numbered.add('$base-$n');
  }
  if (numbered.length < 2) return null;
  final frames = has(base) && numbered.length == 2 ? [numbered[0], base, numbered[1], base] : numbered;
  return frames.contains(name) ? frames : null;
}

({String draw, String cut})? remakeOf(Picture p) {
  final sheet = p.sheet;
  if (sheet == null || sheet.isEmpty) return null;
  final stem = sheet.split('/').last.replaceFirst(RegExp(r'\.png$'), '');
  return (draw: 'design/pixel/gen.sh $stem', cut: 'python3 design/pixel/process.py $stem');
}

bool pictureMatches(Picture p, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return true;
  final shelf = shelves.firstWhere((s) => s.id == shelfOf(p.name));
  final species = Species.values.where((s) => p.name.startsWith('${s.wire}-')).firstOrNull;
  final outfit = species == null ? null : Outfit.values.where((o) => p.name.startsWith('${species.wire}-${o.wire}-')).firstOrNull;
  final words = [p.name, shelf.label, species != null ? speciesLabel[species]! : '', outfit != null ? outfitLabel[outfit]! : ''];
  return words.any((w) => w.toLowerCase().contains(q));
}
