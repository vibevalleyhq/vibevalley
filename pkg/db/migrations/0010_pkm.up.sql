CREATE TABLE IF NOT EXISTS pkm_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    tier TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL DEFAULT '{}',
    tags_json TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pkm_notes_slug_idx ON pkm_notes(slug);
CREATE INDEX IF NOT EXISTS pkm_notes_tier_idx ON pkm_notes(tier);

CREATE TABLE IF NOT EXISTS pkm_aliases (
    alias_slug TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    PRIMARY KEY(alias_slug, rel_path)
);
CREATE INDEX IF NOT EXISTS pkm_aliases_path_idx ON pkm_aliases(rel_path);

CREATE TABLE IF NOT EXISTS pkm_blocks (
    block_id TEXT PRIMARY KEY,
    rel_path TEXT NOT NULL,
    page_title TEXT NOT NULL,
    line INTEGER NOT NULL,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pkm_blocks_path_idx ON pkm_blocks(rel_path);

CREATE TABLE IF NOT EXISTS pkm_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_title TEXT NOT NULL,
    target_slug TEXT NOT NULL,
    block_id TEXT NOT NULL DEFAULT '',
    source_block_id TEXT NOT NULL DEFAULT '',
    line INTEGER NOT NULL,
    byte_start INTEGER NOT NULL,
    byte_end INTEGER NOT NULL,
    snippet TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pkm_links_source_idx ON pkm_links(source_path);
CREATE INDEX IF NOT EXISTS pkm_links_target_idx ON pkm_links(target_slug);
CREATE INDEX IF NOT EXISTS pkm_links_block_idx ON pkm_links(block_id);

CREATE VIRTUAL TABLE IF NOT EXISTS pkm_notes_fts USING fts5(
    rel_path UNINDEXED,
    title,
    tags,
    body,
    tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS vector_storage (
    shadow_table_name TEXT NOT NULL,
    dataset_id TEXT NOT NULL DEFAULT '',
    "index" BLOB,
    PRIMARY KEY (shadow_table_name, dataset_id)
);

CREATE TABLE IF NOT EXISTS _vec_pkm_vectors (
    dataset_id TEXT NOT NULL,
    id TEXT NOT NULL,
    content TEXT,
    meta TEXT,
    embedding BLOB,
    PRIMARY KEY(dataset_id, id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS pkm_vectors USING vec(doc_id);
