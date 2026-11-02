CREATE TABLE http_log_cursors (
  file_id text PRIMARY KEY,
  byte_offset bigint NOT NULL CHECK(byte_offset>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
