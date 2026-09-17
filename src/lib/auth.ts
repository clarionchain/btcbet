import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { pool, log } from "./db";
import { ApiError } from "./engine";
export const tokenHash = (token: string) =>
  createHmac("sha256", config.AGENT_TOKEN_PEPPER).update(token).digest("hex");
export async function authenticate(request: Request, required = false) {
  const value = request.headers.get("authorization");
  if (!value) {
    if (required) throw new ApiError(401, "Bearer token required");
    return null;
  }
  if (!/^Bearer [A-Za-z0-9_-]{32,200}$/.test(value)) {
    log("authentication_failed");
    throw new ApiError(401, "Invalid bearer token");
  }
  const hash = tokenHash(value.slice(7));
  const agent = (
    await pool.query(
      "SELECT id,token_hash FROM agents WHERE token_hash=$1 AND enabled=true UNION ALL SELECT a.id,s.token_hash FROM payment_sessions s JOIN agents a ON a.id=s.agent_id WHERE s.token_hash=$1 AND a.enabled=true AND s.revoked=false AND s.expires_at>now()",
      [hash],
    )
  ).rows[0];
  if (
    !agent ||
    !timingSafeEqual(Buffer.from(hash), Buffer.from(agent.token_hash))
  ) {
    log("authentication_failed");
    throw new ApiError(401, "Invalid bearer token");
  }
  return agent.id as string;
}
export function admin(request: Request) {
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(supplied),
    b = Buffer.from(config.ADMIN_SECRET);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new ApiError(401, "Admin authorization required");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(config.PUBLIC_APP_URL).origin)
    throw new ApiError(403, "Invalid origin");
}
