-- Inbox triage: a comment can be marked done, tagged with workspace-wide tags, and
-- members can be granted the reply capability.
BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE tag (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  name_key text NOT NULL,
  created_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT tag_pkey PRIMARY KEY (id),
  CONSTRAINT tag_organization_id_id_key UNIQUE (organization_id, id),
  CONSTRAINT tag_organization_id_name_key_key UNIQUE (organization_id, name_key),
  CONSTRAINT tag_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 50),
  CONSTRAINT tag_name_key_check CHECK (char_length(name_key) BETWEEN 1 AND 200),
  CONSTRAINT tag_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT tag_created_by_user_id_fkey FOREIGN KEY (created_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX tag_created_by_user_id_idx ON tag (created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE TRIGGER tag_set_updated_at_trg BEFORE UPDATE ON tag
  FOR EACH ROW EXECUTE FUNCTION fb_set_updated_at();

CREATE TABLE comment_tag (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  added_by_user_id uuid,
  added_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT comment_tag_pkey PRIMARY KEY (comment_id, tag_id),
  CONSTRAINT comment_tag_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_tag_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_tag_tag_id_fkey FOREIGN KEY (organization_id, tag_id)
    REFERENCES tag (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_tag_added_by_user_id_fkey FOREIGN KEY (added_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX comment_tag_organization_id_tag_id_comment_id_idx ON comment_tag (organization_id, tag_id, comment_id);
CREATE INDEX comment_tag_tag_id_idx ON comment_tag (tag_id);
CREATE INDEX comment_tag_brand_id_idx ON comment_tag (brand_id);
CREATE INDEX comment_tag_added_by_user_id_idx ON comment_tag (added_by_user_id) WHERE added_by_user_id IS NOT NULL;

CREATE TABLE comment_done (
  organization_id uuid NOT NULL,
  brand_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  done_by_user_id uuid,
  done_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT comment_done_pkey PRIMARY KEY (comment_id),
  CONSTRAINT comment_done_organization_id_brand_id_fkey FOREIGN KEY (organization_id, brand_id)
    REFERENCES brand (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_done_comment_id_fkey FOREIGN KEY (brand_id, comment_id)
    REFERENCES comment (brand_id, id) ON DELETE CASCADE,
  CONSTRAINT comment_done_done_by_user_id_fkey FOREIGN KEY (done_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX comment_done_organization_id_idx ON comment_done (organization_id);
CREATE INDEX comment_done_brand_id_idx ON comment_done (brand_id);
CREATE INDEX comment_done_done_by_user_id_idx ON comment_done (done_by_user_id) WHERE done_by_user_id IS NOT NULL;

-- Only members can be granted a capability, and only the reply one.
CREATE TABLE role_grant (
  organization_id uuid NOT NULL,
  role text NOT NULL,
  capability text NOT NULL,
  granted_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT role_grant_pkey PRIMARY KEY (organization_id, role, capability),
  CONSTRAINT role_grant_grantable_check CHECK (role = 'member' AND capability = 'comment.reply'),
  CONSTRAINT role_grant_organization_id_fkey FOREIGN KEY (organization_id)
    REFERENCES organization (id) ON DELETE CASCADE,
  CONSTRAINT role_grant_granted_by_user_id_fkey FOREIGN KEY (granted_by_user_id)
    REFERENCES app_user (id) ON DELETE SET NULL
);
CREATE INDEX role_grant_granted_by_user_id_idx ON role_grant (granted_by_user_id) WHERE granted_by_user_id IS NOT NULL;

COMMIT;
