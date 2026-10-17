import '../gen/vibevalley.dart';

const speciesLabel = <Species, String>{
  Species.bear: '熊',
  Species.rabbit: '兔子',
  Species.fox: '小狐狸',
  Species.cat: '猫',
  Species.owl: '猫头鹰',
  Species.hedgehog: '刺猬',
  Species.raccoon: '浣熊',
};

const outfitLabel = <Outfit, String>{Outfit.farmer: '农夫', Outfit.gardener: '园丁', Outfit.rain: '雨衣', Outfit.winter: '冬装'};

typedef Cast = ({Species species, Outfit outfit});

int _hash(String s) {
  var h = 0;
  // JavaScript's `for (const c of s) c.charCodeAt(0)`: a code point's first UTF-16 unit.
  for (final r in s.runes) {
    final unit = r > 0xFFFF ? 0xD800 + ((r - 0x10000) >> 10) : r;
    h = (h * 31 + unit) & 0xFFFFFFFF;
  }
  return h;
}

/// A profile the client does not know (deleted while its workers are still about, or not loaded yet) gets an animal picked
/// from its id, the same one every time. Saved profiles always have theirs: the server fills a missing one with this same
/// pick (withCast in server/internal/agent/cast.go), so the two must agree.
Cast castOf(Look? look, String agentId) =>
    (species: look?.species ?? Species.values[_hash(agentId) % Species.values.length], outfit: look?.outfit ?? Outfit.farmer);

String cropSprite(Crop crop) => 'plot-${crop.wire}';

class ManagerLook {
  const ManagerLook(this.id, this.name, this.blurb);
  final String id;
  final String name;
  final String blurb;
}

const managerLooks = [
  ManagerLook('farmer', '青年农夫', '草帽、背带裤，爱笑的年轻人。'),
  ManagerLook('foreman', '包工头', '安全帽、反光背心，对讲机不离身，一喊就到。'),
  ManagerLook('auntie', '农场大婶', '头巾围裙，小本子上记着每块地的活。'),
  ManagerLook('grandpa', '老把式', '白胡子，种了一辈子地，不慌不忙。'),
  ManagerLook('gardener', '园艺师', '宽檐草帽别朵小花，剪刀揣在围裙兜里。'),
  ManagerLook('robot', '机器人管家', '圆滚滚的农场机器人，脸上的屏会笑。'),
];
