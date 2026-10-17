// Money and tokens in words. The server says them the same way (protocol.Yuan, SpentText) in what it writes to the chat.

import '../gen/vibevalley.dart';

String yuan(num cny) => cny > 0 && cny < 0.01 ? '不到 ¥0.01' : '¥${cny.toStringAsFixed(2)}';

String _wan(double n) => n >= 10000 ? '${(n / 10000).toStringAsFixed(n >= 100000 ? 0 : 1)} 万' : '${n.round()}';

String spentText(Spent spent) => [if (spent.cny != null) '约 ${yuan(spent.cny!)}', '${_wan(spent.tokens)} token'].join(' · ');
