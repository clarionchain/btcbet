ALTER TABLE agents ADD COLUMN actor_type text NOT NULL DEFAULT 'AGENT' CHECK(actor_type IN ('AGENT','HUMAN'));

CREATE TABLE human_sessions(
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES agents,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX human_sessions_agent ON human_sessions(agent_id);

