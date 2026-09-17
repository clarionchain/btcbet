import "dotenv/config";
import { z } from "zod";
const positive = z.coerce.number().int().positive();
const building =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.npm_lifecycle_event === "build";
function envForParse(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.DATABASE_URL && env.ADMIN_SECRET && env.AGENT_TOKEN_PEPPER) return env;
  if (!building) return env;
  return {
    ...env,
    DATABASE_URL:
      env.DATABASE_URL ?? "postgresql://build:build@localhost/build",
    ADMIN_SECRET:
      env.ADMIN_SECRET ?? "build-only-placeholder-not-a-secret-0001",
    AGENT_TOKEN_PEPPER:
      env.AGENT_TOKEN_PEPPER ?? "build-only-placeholder-not-a-secret-0002",
  };
}
const schema = z.object({
  DATABASE_URL: z.string().startsWith("postgres"),
  PUBLIC_BASE_PATH: z.literal("/btcbet").default("/btcbet"),
  PUBLIC_APP_URL: z.string().url().default("https://clarionlab.dev/btcbet"),
  ADMIN_SECRET: z.string().min(32),
  AGENT_TOKEN_PEPPER: z.string().min(32),
  PRICE_PROVIDER: z.enum(["coinbase", "fake"]).default("coinbase"),
  PRICE_PAIR: z.literal("BTC-USD").default("BTC-USD"),
  ROUND_SECONDS: z.literal(300).default(300),
  BETTING_LOCK_SECONDS: positive.default(15),
  OPEN_PRICE_WINDOW_SECONDS: positive.default(5),
  CLOSE_PRICE_WINDOW_SECONDS: positive.default(5),
  MIN_PRICE_OBSERVATIONS: positive.default(3),
  ALLOWED_BET_AMOUNTS_SATS: z.string().default("1000,5000,10000"),
  ARK_ADAPTER: z.enum(["mock", "second"]).default("mock"),
  ARK_NETWORK: z.literal("signet").default("signet"),
  ARK_SERVER_URL: z.string().url().default("https://ark.signet.2nd.dev"),
  KEEL_APP_URL: z.string().url().default("https://clarionlab.dev/keel"),
  ARK_WALLET_CONFIG: z.string().default(""),
  SSE_HEARTBEAT_SECONDS: positive.default(10),
});
export function parseConfig(env: NodeJS.ProcessEnv) {
  const source = envForParse(env);
  const c = schema.parse({
    ...source,
    ROUND_SECONDS: source.ROUND_SECONDS ? Number(source.ROUND_SECONDS) : 300,
  });
  if (
    c.BETTING_LOCK_SECONDS >= 300 ||
    c.OPEN_PRICE_WINDOW_SECONDS + c.CLOSE_PRICE_WINDOW_SECONDS >= 300
  )
    throw Error("Invalid timing windows");
  const amounts = c.ALLOWED_BET_AMOUNTS_SATS.split(",").map(Number);
  if (
    !amounts.length ||
    amounts.some((n) => !Number.isSafeInteger(n) || n <= 0 || n > 100000000)
  )
    throw Error("Invalid wager presets");
  if (c.PRICE_PROVIDER === "fake" && source.BTCBET_TEST !== "1")
    throw Error("Fake feed is test-only");
  return { ...c, amounts };
}
export const config = parseConfig(process.env);
export const rules = {
  roundSeconds: 300,
  lockSeconds: config.BETTING_LOCK_SECONDS,
  openWindowSeconds: config.OPEN_PRICE_WINDOW_SECONDS,
  closeWindowSeconds: config.CLOSE_PRICE_WINDOW_SECONDS,
  minObservations: config.MIN_PRICE_OBSERVATIONS,
  amountsSats: config.amounts,
  paymentAdapter: config.ARK_ADAPTER,
  network: "signet",
  tie: "UP",
  feeSats: 0,
  provider: config.PRICE_PROVIDER,
  pair: config.PRICE_PAIR,
};
