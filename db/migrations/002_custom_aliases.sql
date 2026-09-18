-- Custom aliases live in the same short_code column as generated codes,
-- so the UNIQUE constraint on short_code is what detects collisions.
ALTER TABLE urls ADD COLUMN is_custom BOOLEAN NOT NULL DEFAULT false;

-- Used to hand back the existing short link when the same URL is submitted again.
-- Only generated links are reused; an explicit alias always gets its own row.
CREATE INDEX urls_long_url_idx ON urls (long_url) WHERE NOT is_custom;
