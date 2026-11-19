/// Whitespace matching JS `\s`.
#[inline]
pub const fn is_space(c: u32) -> bool {
    if c < 128 {
        return c == 32 || (c >= 9 && c <= 13);
    }
    c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff
}

#[inline]
pub const fn is_space_char(c: char) -> bool {
    is_space(c as u32)
}

#[inline]
pub const fn is_blank(c: u32) -> bool {
    c == 32 || c == 9
}

#[inline]
pub const fn is_line_end(c: u32) -> bool {
    c == 10 || c == 13 || c == 0x2028 || c == 0x2029
}

#[inline]
pub const fn is_digit(c: u32) -> bool {
    c >= 48 && c <= 57
}

#[inline]
pub const fn is_letter(c: u32) -> bool {
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

#[inline]
pub const fn is_hex(c: u32) -> bool {
    (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
}

/// ASCII `\w`.
#[inline]
pub const fn is_word(c: u32) -> bool {
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95
}
