-- One row per redirect, written in batches by the click worker (src/worker.js).
-- The visitor's IP is only used for the geo lookup and is never stored.
CREATE TABLE click_events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id    UUID        NOT NULL UNIQUE,  -- generated at redirect time; makes reprocessing a no-op
    url_id      BIGINT      NOT NULL REFERENCES urls (id) ON DELETE CASCADE,
    clicked_at  TIMESTAMPTZ NOT NULL,
    referrer    TEXT,
    user_agent  TEXT,
    country     CHAR(2),
    region      TEXT,
    city        TEXT
);

CREATE INDEX click_events_url_time_idx ON click_events (url_id, clicked_at);
