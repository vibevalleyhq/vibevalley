use std::collections::BTreeMap;

/// RGBA color parsed from a CSS hex string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub fn from_hex(hex: &str) -> Option<Self> {
        let h = hex.strip_prefix('#')?;
        match h.len() {
            3 => {
                let r = u8::from_str_radix(&h[0..1], 16).ok()?;
                let g = u8::from_str_radix(&h[1..2], 16).ok()?;
                let b = u8::from_str_radix(&h[2..3], 16).ok()?;
                Some(Self {
                    r: r * 17,
                    g: g * 17,
                    b: b * 17,
                    a: 255,
                })
            }
            4 => {
                let r = u8::from_str_radix(&h[0..1], 16).ok()?;
                let g = u8::from_str_radix(&h[1..2], 16).ok()?;
                let b = u8::from_str_radix(&h[2..3], 16).ok()?;
                let a = u8::from_str_radix(&h[3..4], 16).ok()?;
                Some(Self {
                    r: r * 17,
                    g: g * 17,
                    b: b * 17,
                    a: a * 17,
                })
            }
            6 => Some(Self {
                r: u8::from_str_radix(&h[0..2], 16).ok()?,
                g: u8::from_str_radix(&h[2..4], 16).ok()?,
                b: u8::from_str_radix(&h[4..6], 16).ok()?,
                a: 255,
            }),
            8 => Some(Self {
                r: u8::from_str_radix(&h[0..2], 16).ok()?,
                g: u8::from_str_radix(&h[2..4], 16).ok()?,
                b: u8::from_str_radix(&h[4..6], 16).ok()?,
                a: u8::from_str_radix(&h[6..8], 16).ok()?,
            }),
            _ => None,
        }
    }

    pub fn to_hex(self) -> String {
        if self.a == 255 {
            format!("#{:02X}{:02X}{:02X}", self.r, self.g, self.b)
        } else {
            format!("#{:02X}{:02X}{:02X}{:02X}", self.r, self.g, self.b, self.a)
        }
    }
}

/// Validates `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` hex colors identically to `vscode-textmate`.
pub fn is_valid_hex_color(hex: &str) -> bool {
    let Some(rest) = hex.strip_prefix('#') else {
        return false;
    };
    matches!(rest.len(), 3 | 4 | 6 | 8) && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 1-based color palette mapping hex color strings to compact numeric IDs (`0` = unset).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorMap {
    is_frozen: bool,
    last_color_id: u16,
    id_to_color: Vec<String>,
    color_to_id: BTreeMap<String, u16>,
}

impl Default for ColorMap {
    fn default() -> Self {
        Self::new(None)
    }
}

impl ColorMap {
    pub fn new(preset: Option<&[String]>) -> Self {
        let mut id_to_color = Vec::new();
        let mut color_to_id = BTreeMap::new();
        let is_frozen;

        if let Some(colors) = preset {
            is_frozen = true;
            for (i, c) in colors.iter().enumerate() {
                id_to_color.push(c.clone());
                color_to_id.insert(c.clone(), i as u16);
            }
        } else {
            is_frozen = false;
            // Slot 0 is reserved for "unset / inherit" matching vscode-textmate's 1-based ids.
            id_to_color.push(String::new());
        }

        Self {
            is_frozen,
            last_color_id: 0,
            id_to_color,
            color_to_id,
        }
    }

    pub fn get_id(&mut self, color: Option<&str>) -> u16 {
        let Some(raw) = color else {
            return 0;
        };
        let upper = raw.to_ascii_uppercase();
        if let Some(&id) = self.color_to_id.get(&upper) {
            return id;
        }
        assert!(!self.is_frozen, "missing color in frozen color map: {upper}");
        self.last_color_id += 1;
        let id = self.last_color_id;
        self.color_to_id.insert(upper.clone(), id);
        if self.id_to_color.len() <= id as usize {
            self.id_to_color.resize(id as usize + 1, String::new());
        }
        self.id_to_color[id as usize] = upper;
        id
    }

    pub fn color_map(&self) -> &[String] {
        &self.id_to_color
    }

    pub fn get_color(&self, id: u16) -> Option<&str> {
        let s = self.id_to_color.get(id as usize)?;
        if s.is_empty() { None } else { Some(s.as_str()) }
    }
}
