//! Conservative 900-parameter SQLite/PostgreSQL batch chunking helpers.

/// Conservative bind-parameter budget per multi-row SQL statement so chunked
/// `INSERT` and `IN (...)` queries stay below SQLite's 999-parameter default
/// limit as well as PostgreSQL's 65,535 limit.
pub const MAX_SQL_BIND_PARAMS: usize = 900;

/// Maximum rows per batch statement given `columns_per_row` bind parameters per row.
pub const fn batch_chunk_rows(columns_per_row: usize) -> usize {
    if columns_per_row == 0 {
        return MAX_SQL_BIND_PARAMS;
    }
    let rows = MAX_SQL_BIND_PARAMS / columns_per_row;
    if rows == 0 { 1 } else { rows }
}

/// Iterates over `items` in slices sized safely below [`MAX_SQL_BIND_PARAMS`].
pub fn chunk_slice<T>(items: &[T], columns_per_row: usize) -> std::slice::Chunks<'_, T> {
    items.chunks(batch_chunk_rows(columns_per_row))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_chunk_rows_respects_900_param_ceiling() {
        assert_eq!(batch_chunk_rows(1), 900);
        assert_eq!(batch_chunk_rows(10), 90);
        assert_eq!(batch_chunk_rows(1000), 1);
        let data: Vec<usize> = (0..250).collect();
        let chunks: Vec<usize> = chunk_slice(&data, 10).map(<[usize]>::len).collect();
        assert_eq!(chunks, vec![90, 90, 70]);
    }
}
