use std::collections::HashSet;
use std::sync::OnceLock;

const KEYWORDS: &str = "\
aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood \
cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray \
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen \
darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue \
firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew \
hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan \
lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray \
lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue \
mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred \
midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid \
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple \
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue \
slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white \
whitesmoke yellow yellowgreen transparent currentcolor inherit initial unset revert \
accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext \
graytext highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext \
activeborder activecaption appworkspace background buttonhighlight buttonshadow captiontext inactiveborder \
inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface \
threedhighlight threedlightshadow threedshadow window windowframe windowtext";

fn keyword_set() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| KEYWORDS.split(' ').collect())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TermKind {
    Bad,
    Number,
    Percent,
    Angle,
    None,
}

fn term_kind(term: &str) -> TermKind {
    if term.eq_ignore_ascii_case("none") {
        return TermKind::None;
    }
    let bytes = term.as_bytes();
    let n = bytes.len();
    let mut i = 0;
    if i < n && matches!(bytes[i], b'+' | b'-') {
        i += 1;
    }
    let int_start = i;
    while i < n && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let has_int = i > int_start;
    let mut has_frac = false;
    if i < n && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < n && bytes[i].is_ascii_digit() {
            i += 1;
        }
        has_frac = i > frac_start;
        if !has_frac {
            return TermKind::Bad;
        }
    }
    if !has_int && !has_frac {
        return TermKind::Bad;
    }
    if i < n && matches!(bytes[i], b'e' | b'E') {
        i += 1;
        if i < n && matches!(bytes[i], b'+' | b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < n && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return TermKind::Bad;
        }
    }
    let unit = &term[i..];
    if unit.is_empty() {
        TermKind::Number
    } else if unit == "%" {
        TermKind::Percent
    } else if unit.eq_ignore_ascii_case("deg") || unit.eq_ignore_ascii_case("grad") || unit.eq_ignore_ascii_case("rad") || unit.eq_ignore_ascii_case("turn") {
        TermKind::Angle
    } else {
        TermKind::Bad
    }
}

fn is_alpha(term: &str, modern: bool) -> bool {
    let k = term_kind(term);
    matches!(k, TermKind::Number | TermKind::Percent) || (modern && k == TermKind::None)
}

fn is_function_color(color: &str) -> bool {
    let Some(open) = color.find('(') else {
        return false;
    };
    let hsl = color.starts_with("hsl");
    let name = &color[..open];
    if !matches!(name, "rgb" | "rgba" | "hsl" | "hsla") {
        return false;
    }
    if color.len() > 120 || color.find(')') != Some(color.len() - 1) {
        return false;
    }
    let inner = color[open + 1..color.len() - 1].trim();
    let legacy = inner.contains(',');
    let (parts, alpha): (Vec<&str>, Option<&str>) = if legacy {
        let mut list: Vec<&str> = inner.split(',').map(str::trim).collect();
        let a = if list.len() == 4 { list.pop() } else { None };
        (list, a)
    } else {
        let slash: Vec<&str> = inner.split('/').collect();
        if slash.len() > 2 {
            return false;
        }
        let list: Vec<&str> = slash[0].split_whitespace().collect();
        let a = slash.get(1).map(|s| s.trim());
        (list, a)
    };
    if parts.len() != 3 || alpha.is_some_and(|a| !is_alpha(a, !legacy)) {
        return false;
    }
    let kinds = [term_kind(parts[0]), term_kind(parts[1]), term_kind(parts[2])];
    if legacy {
        if hsl {
            return matches!(kinds[0], TermKind::Number | TermKind::Angle) && kinds[1] == TermKind::Percent && kinds[2] == TermKind::Percent;
        }
        return matches!(kinds[0], TermKind::Number | TermKind::Percent) && kinds[1] == kinds[0] && kinds[2] == kinds[0];
    }
    for (i, &k) in kinds.iter().enumerate() {
        let ok = matches!(k, TermKind::Number | TermKind::None) || if hsl && i == 0 { k == TermKind::Angle } else { k == TermKind::Percent };
        if !ok {
            return false;
        }
    }
    true
}

pub fn is_css_color(color: &str) -> bool {
    if color.contains('(') {
        return is_function_color(color);
    }
    keyword_set().contains(color.to_ascii_lowercase().as_str())
}
