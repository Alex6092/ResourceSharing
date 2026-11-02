CREATE TABLE users (
  id uuid PRIMARY KEY,
  moodle_issuer text NOT NULL,
  moodle_subject bigint NOT NULL CHECK (moodle_subject > 0),
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  capabilities text[] NOT NULL DEFAULT '{}',
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(moodle_issuer,moodle_subject)
);
CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE login_transactions (
  state_hash char(64) PRIMARY KEY,
  browser_hash char(64) NOT NULL,
  verifier text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('manage','download')),
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE service_accounts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE folders (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES folders(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES users(id),
  name varchar(255) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id IS DISTINCT FROM parent_id)
);
CREATE UNIQUE INDEX folders_name ON folders(COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE TABLE resources (
  id uuid PRIMARY KEY,
  folder_id uuid REFERENCES folders(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES users(id),
  name varchar(255) NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','ready','trashed','missing')),
  current_version_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX resources_name ON resources(COALESCE(folder_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name)) WHERE state <> 'trashed';
CREATE TABLE resource_versions (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES resources(id),
  number integer NOT NULL CHECK (number > 0),
  uploader_id uuid NOT NULL REFERENCES users(id),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  mime_type text NOT NULL DEFAULT 'application/octet-stream',
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  purged_at timestamptz,
  UNIQUE(resource_id,number),
  UNIQUE(resource_id,id)
);
ALTER TABLE resources ADD CONSTRAINT resource_current_version FOREIGN KEY (id,current_version_id) REFERENCES resource_versions(resource_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE uploads (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES resources(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  base_version_id uuid,
  version_id uuid NOT NULL UNIQUE,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= size_bytes),
  fingerprint varchar(512) NOT NULL,
  expected_sha256 char(64),
  actual_sha256 char(64),
  validation_attempts integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','uploading','received','verifying','publishing','completed','cancelled','expired','error')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uploads_resource_active ON uploads(resource_id) WHERE state IN ('reserved','uploading','received','verifying','publishing');
CREATE INDEX uploads_owner ON uploads(owner_id,last_activity_at);
CREATE TABLE download_links (
  resource_id uuid PRIMARY KEY REFERENCES resources(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE resource_usages (
  resource_id uuid NOT NULL REFERENCES resources(id),
  moodle_context bigint NOT NULL,
  selected_by uuid NOT NULL REFERENCES users(id),
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(resource_id,moodle_context,selected_by)
);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  service_id uuid REFERENCES service_accounts(id),
  action text NOT NULL,
  target_id uuid,
  result text NOT NULL,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_time ON audit_events(occurred_at);
CREATE TABLE service_nonces (
  nonce varchar(128) PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE TABLE download_aggregates (
  day date NOT NULL,
  resource_id uuid NOT NULL REFERENCES resources(id),
  requests bigint NOT NULL DEFAULT 0,
  bytes_sent bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(day,resource_id)
);
CREATE TABLE backup_leases (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
