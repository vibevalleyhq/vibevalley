use std::ops::{BitAnd, BitOr, BitOrAssign};

/// Compact 32-bit dirty-slice / invalidation bitmask.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct DirtyMask(u32);

impl DirtyMask {
    pub const EMPTY: Self = Self(0);

    pub const fn from_bits(bits: u32) -> Self {
        Self(bits)
    }

    pub const fn bit(index: u32) -> Self {
        if index < 32 { Self(1u32 << index) } else { Self::EMPTY }
    }

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }

    pub const fn intersects(self, other: Self) -> bool {
        (self.0 & other.0) != 0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    pub const fn without(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }
}

impl BitOr for DirtyMask {
    type Output = Self;

    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for DirtyMask {
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for DirtyMask {
    type Output = Self;

    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_mask_bitwise_operations() {
        let a = DirtyMask::bit(0);
        let b = DirtyMask::bit(3);
        let mut combined = a | b;
        assert!(!combined.is_empty());
        assert!(combined.contains(a));
        assert!(combined.intersects(b));
        combined |= DirtyMask::bit(5);
        assert_eq!(combined.without(b), DirtyMask::from_bits((1 << 0) | (1 << 5)));
        assert_eq!(DirtyMask::bit(32), DirtyMask::EMPTY);
    }
}
