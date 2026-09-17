-- Preserve simulated history and prevent sending real sats for mock obligations.
UPDATE rounds r SET rules=rules || jsonb_build_object('paymentAdapter',CASE WHEN EXISTS(SELECT 1 FROM bets b WHERE b.round_id=r.id AND b.response->>'paymentRequest' LIKE 'tark1%') THEN 'second' ELSE 'mock' END) WHERE NOT rules ? 'paymentAdapter';
