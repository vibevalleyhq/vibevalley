//! Pure-Rust ISO/IEC 18004 QR Code encoder (byte mode, error-correction level L, versions 1–40).

use serde::Serialize;

/// Encoded QR code grid including its quiet zone (`'1'` = dark, `'0'` = light).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QrMatrix {
    pub size: usize,
    pub rows: Vec<String>,
}

/// `(ec_codewords_per_block, num_blocks)` for error-correction level L, versions 1..=40 (ISO/IEC 18004 Table 9).
const EC_L: [(usize, usize); 40] = [
    (7, 1),
    (10, 1),
    (15, 1),
    (20, 1),
    (26, 1),
    (18, 2),
    (20, 2),
    (24, 2),
    (30, 2),
    (18, 4),
    (20, 4),
    (24, 4),
    (26, 4),
    (30, 4),
    (22, 6),
    (24, 6),
    (28, 6),
    (30, 6),
    (28, 7),
    (28, 8),
    (28, 8),
    (28, 9),
    (30, 9),
    (30, 10),
    (26, 12),
    (28, 12),
    (30, 12),
    (30, 13),
    (30, 14),
    (30, 15),
    (30, 16),
    (30, 17),
    (30, 18),
    (30, 19),
    (30, 19),
    (30, 20),
    (30, 21),
    (30, 22),
    (30, 24),
    (30, 25),
];

/// Encodes `text` as UTF-8 bytes into a QR matrix with `border` light modules around it.
pub fn encode(text: &str, border: usize) -> Result<QrMatrix, String> {
    let bytes = text.as_bytes();
    let border = border.min(16);
    let version = select_version(bytes.len())?;
    let dim = version * 4 + 17;
    let total_cw = total_codewords(version);
    let (ec_len, num_blocks) = EC_L[version - 1];
    let data_cw = total_cw - ec_len * num_blocks;

    let data = encode_byte_stream(bytes, version, data_cw);
    let codewords = interleave_with_ec(&data, total_cw, ec_len, num_blocks);

    let mut is_func = vec![false; dim * dim];
    let mut base = vec![false; dim * dim];
    draw_function_patterns(version, dim, &mut base, &mut is_func);
    draw_codewords(dim, &codewords, &mut base, &is_func);

    let mut best_mask = 0u8;
    let mut best_penalty = u32::MAX;
    let mut best_modules = Vec::new();
    for mask in 0..8u8 {
        let mut trial = base.clone();
        apply_mask(dim, mask, &mut trial, &is_func);
        draw_format_bits(dim, mask, &mut trial);
        let penalty = penalty_score(dim, &trial);
        if penalty < best_penalty {
            best_penalty = penalty;
            best_mask = mask;
            best_modules = trial;
        }
    }
    let _ = best_mask;

    let size = dim + border * 2;
    let mut rows = Vec::with_capacity(size);
    let blank = "0".repeat(size);
    for _ in 0..border {
        rows.push(blank.clone());
    }
    for y in 0..dim {
        let mut row = String::with_capacity(size);
        for _ in 0..border {
            row.push('0');
        }
        for x in 0..dim {
            row.push(if best_modules[y * dim + x] { '1' } else { '0' });
        }
        for _ in 0..border {
            row.push('0');
        }
        rows.push(row);
    }
    for _ in 0..border {
        rows.push(blank.clone());
    }
    Ok(QrMatrix { size, rows })
}

fn select_version(byte_len: usize) -> Result<usize, String> {
    for v in 1..=40 {
        let (ec_len, num_blocks) = EC_L[v - 1];
        let data_cw = total_codewords(v) - ec_len * num_blocks;
        let count_bits = if v <= 9 { 8 } else { 16 };
        let needed_bits = 4 + count_bits + byte_len * 8;
        if needed_bits <= data_cw * 8 {
            return Ok(v);
        }
    }
    Err("QR input exceeds version 40 capacity".into())
}

fn total_codewords(version: usize) -> usize {
    let dim = version * 4 + 17;
    let mut bits = dim * dim - 3 * 64 - 2 * (dim - 16) - 31;
    if version >= 7 {
        bits -= 36;
    }
    if version >= 2 {
        let k = version / 7 + 2;
        bits -= 25 * (k * k - 3) - 10 * (k - 2);
    }
    bits / 8
}

fn alignment_positions(version: usize) -> Vec<usize> {
    if version == 1 {
        return Vec::new();
    }
    let count = version / 7 + 2;
    let last = version * 4 + 10;
    let step = if version == 32 {
        26
    } else {
        ((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2
    };
    let mut pos = vec![6];
    for i in (0..count - 1).rev() {
        pos.push(last - i * step);
    }
    pos
}

fn encode_byte_stream(bytes: &[u8], version: usize, data_cw: usize) -> Vec<u8> {
    let mut bits = Vec::with_capacity(data_cw * 8);
    let push_bits = |buf: &mut Vec<u8>, value: u32, len: usize| {
        for i in (0..len).rev() {
            buf.push(((value >> i) & 1) as u8);
        }
    };
    push_bits(&mut bits, 0b0100, 4);
    push_bits(&mut bits, bytes.len() as u32, if version <= 9 { 8 } else { 16 });
    for &b in bytes {
        push_bits(&mut bits, u32::from(b), 8);
    }
    let capacity_bits = data_cw * 8;
    let terminator = (capacity_bits - bits.len()).min(4);
    push_bits(&mut bits, 0, terminator);
    while !bits.len().is_multiple_of(8) {
        bits.push(0);
    }
    let mut out = Vec::with_capacity(data_cw);
    for chunk in bits.as_chunks::<8>().0 {
        let mut byte = 0u8;
        for &bit in chunk {
            byte = (byte << 1) | bit;
        }
        out.push(byte);
    }
    let pad = [0xEC, 0x11];
    let mut p = 0;
    while out.len() < data_cw {
        out.push(pad[p & 1]);
        p += 1;
    }
    out
}

fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut res = 0u8;
    for _ in 0..8 {
        if (b & 1) != 0 {
            res ^= a;
        }
        let hi = (a & 0x80) != 0;
        a <<= 1;
        if hi {
            a ^= 0x1D;
        }
        b >>= 1;
    }
    res
}

fn rs_divisor(degree: usize) -> Vec<u8> {
    let mut poly = vec![0u8; degree];
    poly[degree - 1] = 1;
    let mut root = 1u8;
    for _ in 0..degree {
        for j in 0..degree {
            poly[j] = gf_mul(poly[j], root);
            if j + 1 < degree {
                poly[j] ^= poly[j + 1];
            }
        }
        root = gf_mul(root, 0x02);
    }
    poly
}

fn rs_remainder(data: &[u8], divisor: &[u8]) -> Vec<u8> {
    let mut rem = vec![0u8; divisor.len()];
    for &byte in data {
        let factor = byte ^ rem[0];
        rem.copy_within(1.., 0);
        *rem.last_mut().expect("non-empty divisor") = 0;
        for (r, &d) in rem.iter_mut().zip(divisor) {
            *r ^= gf_mul(d, factor);
        }
    }
    rem
}

fn interleave_with_ec(data: &[u8], total_cw: usize, ec_len: usize, num_blocks: usize) -> Vec<u8> {
    let num_short = num_blocks - (total_cw % num_blocks);
    let short_data_len = total_cw / num_blocks - ec_len;
    let divisor = rs_divisor(ec_len);

    let mut data_blocks = Vec::with_capacity(num_blocks);
    let mut ec_blocks = Vec::with_capacity(num_blocks);
    let mut offset = 0;
    for i in 0..num_blocks {
        let len = short_data_len + usize::from(i >= num_short);
        let slice = &data[offset..offset + len];
        offset += len;
        data_blocks.push(slice);
        ec_blocks.push(rs_remainder(slice, &divisor));
    }

    let mut out = Vec::with_capacity(total_cw);
    for col in 0..=short_data_len {
        for block in &data_blocks {
            if let Some(&b) = block.get(col) {
                out.push(b);
            }
        }
    }
    for col in 0..ec_len {
        for ec in &ec_blocks {
            out.push(ec[col]);
        }
    }
    out
}

fn set_func(dim: usize, x: usize, y: usize, dark: bool, modules: &mut [bool], is_func: &mut [bool]) {
    let idx = y * dim + x;
    modules[idx] = dark;
    is_func[idx] = true;
}

fn draw_finder(dim: usize, cx: isize, cy: isize, modules: &mut [bool], is_func: &mut [bool]) {
    for dy in -4..=4 {
        for dx in -4..=4 {
            let x = cx + dx;
            let y = cy + dy;
            if x >= 0 && y >= 0 && (x as usize) < dim && (y as usize) < dim {
                let dist = dx.abs().max(dy.abs());
                let dark = dist != 2 && dist != 4;
                set_func(dim, x as usize, y as usize, dark, modules, is_func);
            }
        }
    }
}

fn draw_alignment(dim: usize, cx: usize, cy: usize, modules: &mut [bool], is_func: &mut [bool]) {
    for dy in -2..=2isize {
        for dx in -2..=2isize {
            let dist = dx.abs().max(dy.abs());
            set_func(dim, (cx as isize + dx) as usize, (cy as isize + dy) as usize, dist != 1, modules, is_func);
        }
    }
}

fn draw_function_patterns(version: usize, dim: usize, modules: &mut [bool], is_func: &mut [bool]) {
    for i in 0..dim {
        set_func(dim, 6, i, i % 2 == 0, modules, is_func);
        set_func(dim, i, 6, i % 2 == 0, modules, is_func);
    }
    draw_finder(dim, 3, 3, modules, is_func);
    draw_finder(dim, (dim - 4) as isize, 3, modules, is_func);
    draw_finder(dim, 3, (dim - 4) as isize, modules, is_func);

    let align = alignment_positions(version);
    for (i, &ax) in align.iter().enumerate() {
        for (j, &ay) in align.iter().enumerate() {
            let corner = (i == 0 && j == 0) || (i == 0 && j + 1 == align.len()) || (i + 1 == align.len() && j == 0);
            if !corner {
                draw_alignment(dim, ax, ay, modules, is_func);
            }
        }
    }

    // Reserve format info strips (filled after mask selection) and dark module.
    draw_format_bits_reserved(dim, modules, is_func);
    if version >= 7 {
        draw_version_bits(version, dim, modules, is_func);
    }
}

fn draw_format_bits_reserved(dim: usize, modules: &mut [bool], is_func: &mut [bool]) {
    for i in 0..=5 {
        set_func(dim, 8, i, false, modules, is_func);
    }
    set_func(dim, 8, 7, false, modules, is_func);
    set_func(dim, 8, 8, false, modules, is_func);
    set_func(dim, 7, 8, false, modules, is_func);
    for i in 9..15 {
        set_func(dim, 14 - i, 8, false, modules, is_func);
    }
    for i in 0..8 {
        set_func(dim, dim - 1 - i, 8, false, modules, is_func);
    }
    for i in 8..15 {
        set_func(dim, 8, dim - 15 + i, false, modules, is_func);
    }
    set_func(dim, 8, dim - 8, true, modules, is_func);
}

fn draw_format_bits(dim: usize, mask: u8, modules: &mut [bool]) {
    // Error correction level L = 0b01.
    let data = (0b01u32 << 3) | u32::from(mask);
    let mut rem = data;
    for _ in 0..10 {
        rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    }
    let bits = ((data << 10) | rem) ^ 0x5412;
    let bit = |i: usize| ((bits >> i) & 1) != 0;

    for i in 0..=5 {
        modules[i * dim + 8] = bit(i);
    }
    modules[7 * dim + 8] = bit(6);
    modules[8 * dim + 8] = bit(7);
    modules[8 * dim + 7] = bit(8);
    for i in 9..15 {
        modules[8 * dim + (14 - i)] = bit(i);
    }
    for i in 0..8 {
        modules[8 * dim + (dim - 1 - i)] = bit(i);
    }
    for i in 8..15 {
        modules[(dim - 15 + i) * dim + 8] = bit(i);
    }
    modules[(dim - 8) * dim + 8] = true;
}

fn draw_version_bits(version: usize, dim: usize, modules: &mut [bool], is_func: &mut [bool]) {
    let mut rem = version as u32;
    for _ in 0..12 {
        rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
    }
    let bits = ((version as u32) << 12) | rem;
    for i in 0..18 {
        let dark = ((bits >> i) & 1) != 0;
        let a = dim - 11 + (i % 3);
        let b = i / 3;
        set_func(dim, a, b, dark, modules, is_func);
        set_func(dim, b, a, dark, modules, is_func);
    }
}

fn draw_codewords(dim: usize, codewords: &[u8], modules: &mut [bool], is_func: &[bool]) {
    let mut bit_idx = 0usize;
    let total_bits = codewords.len() * 8;
    let mut right = dim as isize - 1;
    let mut upward = true;
    while right >= 1 {
        if right == 6 {
            right -= 1;
        }
        for step in 0..dim {
            let y = if upward { dim - 1 - step } else { step };
            for dx in 0..2 {
                let x = (right - dx) as usize;
                let idx = y * dim + x;
                if !is_func[idx] && bit_idx < total_bits {
                    let dark = ((codewords[bit_idx >> 3] >> (7 - (bit_idx & 7))) & 1) != 0;
                    modules[idx] = dark;
                    bit_idx += 1;
                }
            }
        }
        upward = !upward;
        right -= 2;
    }
}

fn apply_mask(dim: usize, mask: u8, modules: &mut [bool], is_func: &[bool]) {
    for y in 0..dim {
        for x in 0..dim {
            let idx = y * dim + x;
            if is_func[idx] {
                continue;
            }
            let invert = match mask {
                0 => (x + y).is_multiple_of(2),
                1 => y.is_multiple_of(2),
                2 => x.is_multiple_of(3),
                3 => (x + y).is_multiple_of(3),
                4 => (x / 3 + y / 2).is_multiple_of(2),
                5 => (x * y) % 2 + (x * y) % 3 == 0,
                6 => ((x * y) % 2 + (x * y) % 3).is_multiple_of(2),
                7 => ((x + y) % 2 + (x * y) % 3).is_multiple_of(2),
                _ => false,
            };
            if invert {
                modules[idx] = !modules[idx];
            }
        }
    }
}

fn penalty_score(dim: usize, modules: &[bool]) -> u32 {
    let mut score = 0u32;
    // Rule 1 & Rule 3 along rows and columns.
    for dir in 0..2 {
        for a in 0..dim {
            let mut run_color = false;
            let mut run_len = 0u32;
            let mut hist = [0u32; 7];
            for b in 0..dim {
                let c = if dir == 0 { modules[a * dim + b] } else { modules[b * dim + a] };
                if b == 0 {
                    if c {
                        push_hist(0, &mut hist, dim as u32);
                    }
                    run_color = c;
                    run_len = 1;
                } else if c == run_color {
                    run_len += 1;
                    if run_len == 5 {
                        score += 3;
                    } else if run_len > 5 {
                        score += 1;
                    }
                } else {
                    score += finder_penalty_on_change(run_color, run_len, &mut hist, dim as u32);
                    run_color = c;
                    run_len = 1;
                }
            }
            score += finder_penalty_end(run_color, run_len, &mut hist, dim as u32);
        }
    }
    // Rule 2: 2x2 blocks of same color.
    for y in 0..dim - 1 {
        for x in 0..dim - 1 {
            let c = modules[y * dim + x];
            if c == modules[y * dim + x + 1] && c == modules[(y + 1) * dim + x] && c == modules[(y + 1) * dim + x + 1] {
                score += 3;
            }
        }
    }
    // Rule 4: dark module balance (ceil(|20*dark - 10*total| / total) - 1).
    let dark = modules.iter().filter(|&&m| m).count() as u32;
    let total = (dim * dim) as u32;
    let k = (dark * 20).abs_diff(total * 10).saturating_sub(1) / total;
    score + k * 10
}

fn push_hist(mut run: u32, hist: &mut [u32; 7], dim: u32) {
    if hist[0] == 0 {
        run += dim;
    }
    hist.copy_within(0..6, 1);
    hist[0] = run;
}

fn finder_patterns(hist: &[u32; 7]) -> u32 {
    let n = hist[1];
    if n == 0 || hist[2] != n || hist[3] != n * 3 || hist[4] != n || hist[5] != n {
        return 0;
    }
    let mut hits = 0;
    if hist[0] >= n * 4 && hist[6] >= n {
        hits += 1;
    }
    if hist[6] >= n * 4 && hist[0] >= n {
        hits += 1;
    }
    hits * 40
}

fn finder_penalty_on_change(color: bool, run: u32, hist: &mut [u32; 7], dim: u32) -> u32 {
    if !color {
        push_hist(run, hist, dim);
        finder_patterns(hist)
    } else {
        push_hist(run, hist, dim);
        0
    }
}

fn finder_penalty_end(color: bool, run: u32, hist: &mut [u32; 7], dim: u32) -> u32 {
    let mut extra = 0;
    if color {
        push_hist(run, hist, dim);
        push_hist(dim, hist, dim);
        extra += finder_patterns(hist);
    } else {
        push_hist(run + dim, hist, dim);
        extra += finder_patterns(hist);
    }
    extra
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_short_and_url_payloads_with_quiet_zone_and_finder_patterns() {
        let hello = encode("hello", 2).unwrap();
        assert_eq!(hello.size, 25);
        assert_eq!(hello.rows.len(), 25);
        assert!(hello.rows.iter().all(|r| r.len() == 25));
        // Quiet zone around top/bottom/left/right is all light.
        assert_eq!(hello.rows[0], "0".repeat(25));
        assert_eq!(hello.rows[1], "0".repeat(25));
        assert_eq!(hello.rows[23], "0".repeat(25));
        assert_eq!(hello.rows[24], "0".repeat(25));
        // Top-left and top-right 7x7 finder outer ring at row 2.
        assert_eq!(&hello.rows[2][2..9], "1111111");
        assert_eq!(&hello.rows[2][16..23], "1111111");

        // Matches uqr's version 1 encoding of "hello" (border 2).
        let expected_v1_top = [
            "0000000000000000000000000",
            "0000000000000000000000000",
            "0011111110010110111111100",
            "0010000010110100100000100",
            "0010111010110010101110100",
            "0010111010010100101110100",
            "0010111010100010101110100",
            "0010000010100110100000100",
            "0011111110101010111111100",
        ];
        for (y, row) in expected_v1_top.iter().enumerate() {
            assert_eq!(&hello.rows[y], row, "row {y}");
        }

        let url = encode("https://vibevalley.dev/login?token=1234567890abcdef", 2).unwrap();
        assert_eq!(url.size, 33);
        assert_eq!(url.rows.len(), 33);
    }

    fn fnv64(rows: &[String]) -> u64 {
        let mut h = 14_695_981_039_346_656_037u64;
        for (i, row) in rows.iter().enumerate() {
            if i > 0 {
                h ^= u64::from(b'\n');
                h = h.wrapping_mul(1_099_511_628_211);
            }
            for b in row.bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(1_099_511_628_211);
            }
        }
        h
    }

    #[test]
    fn encodes_high_versions_utf8_and_rejects_oversized_input() {
        // Verified bit-for-bit against ISO/IEC 18004 reference (`uqr`, EC level L, border 2).
        assert_eq!(fnv64(&encode("hello", 2).unwrap().rows), 0xd20b_7f0e_5cd5_2a3d);
        assert_eq!(
            fnv64(&encode("https://vibevalley.dev/login?token=1234567890abcdef", 2).unwrap().rows),
            0x5d3c_c304_bc4f_20ce
        );
        assert_eq!(fnv64(&encode(&"a".repeat(150), 2).unwrap().rows), 0x2936_940d_b962_779a);
        assert_eq!(fnv64(&encode("你好VibeValley二维码测试", 2).unwrap().rows), 0xf5c0_a263_5bdd_ae13);

        let v7 = encode(&"a".repeat(150), 0).unwrap();
        assert_eq!(v7.size, 45);
        let max = encode(&"x".repeat(2953), 0).unwrap();
        assert_eq!(max.size, 177);
        assert!(encode(&"x".repeat(2954), 0).is_err());
    }
}
