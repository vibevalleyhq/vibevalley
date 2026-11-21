use std::collections::HashMap;
use std::sync::OnceLock;

use crate::util::chars::is_word;

const NAMED: &str = "amp:38,lt:60,gt:62,quot:34,apos:39,nbsp:160,shy:173,iexcl:161,cent:162,pound:163,curren:164,yen:165,sect:167,\
copy:169,laquo:171,not:172,reg:174,deg:176,plusmn:177,sup2:178,sup3:179,micro:181,para:182,middot:183,\
sup1:185,raquo:187,frac14:188,frac12:189,frac34:190,iquest:191,times:215,divide:247,ndash:8211,mdash:8212,\
lsquo:8216,rsquo:8217,sbquo:8218,ldquo:8220,rdquo:8221,bdquo:8222,dagger:8224,Dagger:8225,bull:8226,\
hellip:8230,permil:8240,prime:8242,Prime:8243,lsaquo:8249,rsaquo:8250,euro:8364,trade:8482,larr:8592,\
uarr:8593,rarr:8594,darr:8595,harr:8596,lArr:8656,uArr:8657,rArr:8658,dArr:8659,hArr:8660,forall:8704,\
part:8706,exist:8707,empty:8709,nabla:8711,isin:8712,notin:8713,ni:8715,prod:8719,sum:8721,minus:8722,\
radic:8730,infin:8734,and:8743,or:8744,cap:8745,cup:8746,int:8747,there4:8756,sim:8764,cong:8773,\
asymp:8776,ne:8800,equiv:8801,le:8804,ge:8805,sub:8834,sup:8835,sube:8838,supe:8839,oplus:8853,otimes:8855,\
perp:8869,sdot:8901,loz:9674,spades:9824,clubs:9827,hearts:9829,diams:9830,check:10003,cross:10007,\
AMP:38,LT:60,GT:62,QUOT:34,lsqb:91,rsqb:93,lcub:123,rcub:125,verbar:124,VerticalLine:124,midast:42,\
DiacriticalGrave:96,Hat:94,UnderBar:95,\
equals:61,colon:58,semi:59,num:35,percnt:37,lpar:40,rpar:41,lbrack:91,rbrack:93,lbrace:123,rbrace:125,\
vert:124,sol:47,bsol:92,quest:63,excl:33,ast:42,plus:43,comma:44,period:46,dollar:36,commat:64,grave:96,\
hat:94,lowbar:95,tilde:126,Alpha:913,Beta:914,Gamma:915,Delta:916,Epsilon:917,Zeta:918,Eta:919,Theta:920,\
Iota:921,Kappa:922,Lambda:923,Mu:924,Nu:925,Xi:926,Omicron:927,Pi:928,Rho:929,Sigma:931,Tau:932,\
Upsilon:933,Phi:934,Chi:935,Psi:936,Omega:937,alpha:945,beta:946,gamma:947,delta:948,epsilon:949,zeta:950,\
eta:951,theta:952,iota:953,kappa:954,lambda:955,mu:956,nu:957,xi:958,omicron:959,pi:960,rho:961,sigmaf:962,\
sigma:963,tau:964,upsilon:965,phi:966,chi:967,psi:968,omega:969";

static NAMED_MAP: OnceLock<HashMap<&'static str, char>> = OnceLock::new();

fn lookup(name: &str) -> Option<char> {
    let map = NAMED_MAP.get_or_init(|| {
        let mut m = HashMap::new();
        for pair in NAMED.split(',') {
            if let Some((k, v)) = pair.split_once(':')
                && let Ok(code) = v.parse::<u32>()
                && let Some(ch) = char::from_u32(code)
            {
                m.insert(k, ch);
            }
        }
        m
    });
    map.get(name).copied()
}

fn decode_codepoint(n: u32) -> Option<char> {
    if n > 0 && n <= 0x10ffff && !(0xd800..=0xdfff).contains(&n) {
        char::from_u32(n)
    } else {
        None
    }
}

const OPEN: &str = "ﬂ°";
const CLOSE: &str = "¶ß";
const DEGREE: &str = "°";

fn restore_placeholders(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut search = 0usize;
    while let Some(rel) = text[search..].find(OPEN) {
        let from = search + rel;
        let after_open = from + OPEN.len();
        let Some(stop_rel) = text[after_open..].find('¶') else {
            break;
        };
        let stop = after_open + stop_rel;
        let after_pilcrow = stop + '¶'.len_utf8();
        if text[after_pilcrow..].starts_with('ß') {
            let numeric = text[after_open..].starts_with(DEGREE);
            let inner_start = if numeric { after_open + DEGREE.len() } else { after_open };
            out.push_str(&text[last..from]);
            out.push_str(if numeric { "&#" } else { "&" });
            out.push_str(&text[inner_start..stop]);
            out.push(';');
            last = after_pilcrow + 'ß'.len_utf8();
        }
        search = after_pilcrow;
    }
    if last == 0 {
        text.to_string()
    } else {
        out.push_str(&text[last..]);
        out
    }
}

/// Restores encoded placeholder codes back to `#name;` syntax for error messages.
pub fn written_codes(text: &str) -> String {
    if !text.contains(CLOSE) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut search = 0usize;
    while let Some(rel) = text[search..].find(OPEN) {
        let from = search + rel;
        let after_open = from + OPEN.len();
        let inner_start = if text[after_open..].starts_with(DEGREE) {
            after_open + DEGREE.len()
        } else {
            after_open
        };
        let mut end = inner_start;
        while end < text.len() && is_word(text.as_bytes()[end] as u32) {
            end += 1;
        }
        if end > inner_start && text[end..].starts_with(CLOSE) {
            out.push_str(&text[last..from]);
            out.push('#');
            out.push_str(&text[inner_start..end]);
            out.push(';');
            last = end + CLOSE.len();
            search = last;
        } else {
            search = after_open;
        }
    }
    if last == 0 {
        text.to_string()
    } else {
        out.push_str(&text[last..]);
        out
    }
}

/// Decodes Mermaid `#35;` / `#quot;` placeholders and HTML entities in a single pass.
pub fn decode_entities(text: &str) -> String {
    let owned;
    let src: &str = if text.contains(CLOSE) {
        owned = restore_placeholders(text);
        &owned
    } else {
        text
    };
    if !src.contains('&') {
        return src.to_string();
    }
    let mut out = String::with_capacity(src.len());
    let bytes = src.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&'
            && let Some((decoded, next_i)) = try_decode_entity(src, i)
        {
            out.push(decoded);
            i = next_i;
            continue;
        }
        let ch = src[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn try_decode_entity(src: &str, amp: usize) -> Option<(char, usize)> {
    let bytes = src.as_bytes();
    let start = amp + 1;
    if start >= bytes.len() {
        return None;
    }
    if bytes[start] == b'#' {
        let after_hash = start + 1;
        if after_hash >= bytes.len() {
            return None;
        }
        if bytes[after_hash] == b'x' || bytes[after_hash] == b'X' {
            let hex_start = after_hash + 1;
            let mut j = hex_start;
            while j < bytes.len() && bytes[j].is_ascii_hexdigit() {
                j += 1;
            }
            if j > hex_start && bytes.get(j) == Some(&b';') {
                let code = u32::from_str_radix(&src[hex_start..j], 16).ok()?;
                return decode_codepoint(code).map(|c| (c, j + 1));
            }
        } else {
            let mut j = after_hash;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > after_hash && bytes.get(j) == Some(&b';') {
                let code = src[after_hash..j].parse::<u32>().ok()?;
                return decode_codepoint(code).map(|c| (c, j + 1));
            }
        }
        return None;
    }
    let mut j = start;
    while j < bytes.len() && is_word(bytes[j] as u32) {
        j += 1;
    }
    if j > start && bytes.get(j) == Some(&b';') {
        return lookup(&src[start..j]).map(|c| (c, j + 1));
    }
    None
}
