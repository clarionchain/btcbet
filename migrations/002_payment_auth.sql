ALTER TABLE agents ADD COLUMN identity_key text UNIQUE CHECK(identity_key IS NULL OR identity_key ~ '^[0-9a-f]{64}$');
ALTER TABLE agents ADD COLUMN payment_authenticated_at timestamptz;
CREATE TABLE payment_challenges(id uuid PRIMARY KEY,agent_id uuid NOT NULL REFERENCES agents,bet_id uuid NOT NULL UNIQUE REFERENCES bets,message text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,authenticated_at timestamptz);
CREATE TABLE payment_sessions(challenge_id uuid PRIMARY KEY REFERENCES payment_challenges,agent_id uuid NOT NULL REFERENCES agents,token_hash text UNIQUE NOT NULL,expires_at timestamptz NOT NULL,revoked boolean NOT NULL DEFAULT false);
CREATE TABLE payment_auth_rates(key text PRIMARY KEY,window_at timestamptz NOT NULL,count integer NOT NULL);
CREATE TABLE ark_receive_requests(reference text PRIMARY KEY,address text UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ark_send_operations(reference text PRIMARY KEY,amount bigint NOT NULL,destination text NOT NULL,before_ids jsonb NOT NULL,state text NOT NULL CHECK(state IN ('STARTED','CONFIRMED','UNKNOWN')),provider_id text UNIQUE,created_at timestamptz NOT NULL DEFAULT now());
