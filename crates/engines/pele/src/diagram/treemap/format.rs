#[derive(Debug, Clone, Copy)]
pub struct ValueFormatter {
    plus: bool,
    dollar: bool,
    comma: bool,
    precision: Option<usize>,
    trim: bool,
    kind: Option<char>,
}

fn parse_spec(raw: &str) -> Option<ValueFormatter> {
    let spec = if raw == "$0,0" { "$," } else { raw };
    let chars: Vec<char> = spec.chars().collect();
    let mut i = 0usize;

    // Optional fill + align or align: `(?:.?[<>=^])?`
    if i + 1 < chars.len() && matches!(chars[i + 1], '<' | '>' | '=' | '^') {
        i += 2;
    } else if i < chars.len() && matches!(chars[i], '<' | '>' | '=' | '^') {
        i += 1;
    }

    // Optional sign: `([-+( ])?`
    let mut plus = false;
    if i < chars.len() && matches!(chars[i], '-' | '+' | '(' | ' ') {
        plus = chars[i] == '+';
        i += 1;
    }

    // Optional `$`: `(\$)?`
    let mut dollar = false;
    if i < chars.len() && chars[i] == '$' {
        dollar = true;
        i += 1;
    }

    // Optional `0` + width digits: `0?\d*`
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }

    // Optional `,`: `(,)?`
    let mut comma = false;
    if i < chars.len() && chars[i] == ',' {
        comma = true;
        i += 1;
    }

    // Optional `.(\d+)`: `(?:\.(\d+))?`
    let mut precision = None;
    if i < chars.len() && chars[i] == '.' {
        i += 1;
        let start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        let s: String = chars[start..i].iter().collect();
        precision = Some(s.parse::<usize>().unwrap_or(20).min(20));
    }

    // Optional `~`: `(~)?`
    let mut trim = false;
    if i < chars.len() && chars[i] == '~' {
        trim = true;
        i += 1;
    }

    // Optional type: `([a-zA-Z%])?`
    let mut kind = None;
    if i < chars.len() && (chars[i].is_ascii_alphabetic() || chars[i] == '%') {
        kind = Some(chars[i]);
        i += 1;
    }

    if i != chars.len() {
        return None;
    }
    Some(ValueFormatter {
        plus,
        dollar,
        comma,
        precision,
        trim,
        kind,
    })
}

fn group(digits: &str) -> String {
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    let len = digits.len();
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (len - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn format_exp_js(val: f64, prec: usize) -> String {
    let raw = format!("{val:.prec$e}");
    if let Some((mant, exp)) = raw.split_once('e') {
        if exp.starts_with('-') {
            format!("{mant}e{exp}")
        } else {
            format!("{mant}e+{exp}")
        }
    } else {
        raw
    }
}

fn format_default_js(abs: f64, precision: Option<usize>) -> String {
    if !abs.is_finite() {
        return if abs.is_nan() { "NaN".to_string() } else { "Infinity".to_string() };
    }
    if abs == 0.0 {
        return "0".to_string();
    }
    let p = precision.unwrap_or(12).max(1);
    let rounded: f64 = format!("{abs:.prec$e}", prec = p - 1).parse().unwrap_or(abs);
    if rounded == 0.0 {
        return "0".to_string();
    }
    if !(1e-6..1e21).contains(&rounded) {
        let raw = format!("{rounded:e}");
        if let Some((mant, exp)) = raw.split_once('e') {
            return if exp.starts_with('-') {
                format!("{mant}e{exp}")
            } else {
                format!("{mant}e+{exp}")
            };
        }
    }
    format!("{rounded}")
}

impl ValueFormatter {
    pub fn from_spec(spec: &str) -> Self {
        parse_spec(spec).unwrap_or(Self {
            plus: false,
            dollar: false,
            comma: true,
            precision: None,
            trim: false,
            kind: None,
        })
    }

    pub fn format(self, value: f64) -> String {
        let abs = value.abs();
        let mut suffix = "";
        let mut body = match self.kind {
            Some('f') => format!("{abs:.prec$}", prec = self.precision.unwrap_or(6)),
            Some('%') => {
                suffix = "%";
                format!("{:.prec$}", abs * 100.0, prec = self.precision.unwrap_or(6))
            }
            Some('d') => format!("{:.0}", abs.round()),
            Some('e') => format_exp_js(abs, self.precision.unwrap_or(6)),
            _ => format_default_js(abs, self.precision),
        };

        if self.trim && body.contains('.') && !body.contains('e') {
            while body.ends_with('0') {
                body.pop();
            }
            if body.ends_with('.') {
                body.pop();
            }
        }
        if self.comma && !body.contains('e') {
            if let Some(dot) = body.find('.') {
                body = format!("{}{}", group(&body[..dot]), &body[dot..]);
            } else {
                body = group(&body);
            }
        }
        let sign = if value < 0.0 {
            "-"
        } else if self.plus {
            "+"
        } else {
            ""
        };
        let prefix = if self.dollar { "$" } else { "" };
        format!("{sign}{prefix}{body}{suffix}")
    }
}
