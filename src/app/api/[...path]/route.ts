import {
  authInstructions,
  paymentProposal,
  confirmation,
  requestPayment,
  confirmPayment,
  limitPaymentAuth,
} from "@/lib/payment-auth";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticate, admin } from "@/lib/auth";
import { ApiError, createIntent } from "@/lib/engine";
import {
  current,
  history,
  roundView,
  performance,
  health,
  getBet,
} from "@/lib/read";
import { pool, log } from "@/lib/db";
import { config } from "@/lib/config";
import { readFile } from "node:fs/promises";
import {
  authenticateHuman,
  confirmHumanBet,
  createHuman,
  createHumanBet,
  humanBet,
  humanBetQr,
  humanCookie,
  humanMe,
  humanProfile,
  recoverHuman,
  requireSameOrigin,
} from "@/lib/human";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const intent = z
  .object({
    roundId: z.string().regex(/^\d{10}$/),
    direction: z.enum(["UP", "DOWN"]),
    amountSats: z.number().int().positive().max(100000000),
    returnAddress: z.string().min(3).max(500),
    idempotencyKey: z.string().min(8).max(120),
  })
  .strict();
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const sessionJson = (data: unknown, token: string, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": humanCookie(token),
    },
  });
async function body(req: Request) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "JSON content type required");
  if (Number(req.headers.get("content-length")) > 8192)
    throw new ApiError(413, "Body too large");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "JSON body required");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) {
      await reader.cancel();
      throw new ApiError(413, "Body too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new ApiError(400, "Invalid JSON");
  }
}
async function route(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const correlationId = randomUUID();
  try {
    const path = (await ctx.params).path.join("/");
    if (req.method === "GET") {
      if (path === "health" || path === "ready") {
        const h = await health();
        return json(h, path === "ready" && h.status !== "ready" ? 503 : 200);
      }
      if (path === "v1/auth") return json(authInstructions());
      if (path === "v1/humans/me") {
        const human = await authenticateHuman(req);
        return json(await humanMe(human!.agent_id));
      }
      if (/^v1\/humans\/bets\/[0-9a-f-]+\/qr$/.test(path)) {
        const human = await authenticateHuman(req);
        const id = z.uuid().parse(path.split("/")[3]);
        return new Response(await humanBetQr(human!.agent_id, id), {
          headers: {
            "Content-Type": "image/svg+xml",
            "Cache-Control": "private, no-store",
            "Content-Security-Policy":
              "default-src 'none'; style-src 'unsafe-inline'",
          },
        });
      }
      if (path === "v1/openapi")
        return new Response(await readFile("public/openapi.json", "utf8"), {
          headers: { "Content-Type": "application/json" },
        });
      if (path === "v1/events") return stream(req);
      if (path === "v1/admin/status") {
        admin(req);
        return json({
          ...(await health()),
          failures: (
            await pool.query(
              "SELECT id,status,attempts,last_error FROM outgoing_payments WHERE status IN ('FAILED','UNKNOWN')",
            )
          ).rows,
          unresolvedArkSends: (
            await pool.query(
              "SELECT reference,state,created_at FROM ark_send_operations WHERE state IN ('STARTED','UNKNOWN')",
            )
          ).rows,
          paused: (
            await pool.query(
              "SELECT value FROM system_settings WHERE key='paused'",
            )
          ).rows[0]?.value,
        });
      }
      if (path === "v1/markets/current")
        return json(await current((await authenticate(req)) ?? undefined));
      if (path === "v1/markets") return json({ rounds: await history() });
      if (/^v1\/markets\/\d{10}$/.test(path)) {
        const r = await roundView(path.split("/")[2]);
        if (!r) throw new ApiError(404, "Round not found");
        return json(r);
      }
      if (path === "v1/dashboard")
        return json({
          market: await current(),
          history: await history(),
          leaderboard: await performance(),
          health: await health(),
        });
      if (path === "v1/agents/me/performance")
        return json((await performance((await authenticate(req, true))!))[0]);
      if (path.startsWith("v1/bets/")) {
        const agent = (await authenticate(req, true))!;
        const id = z.uuid().parse(path.split("/")[2]);
        const b = await getBet(id, agent);
        if (!b) throw new ApiError(404, "Bet not found");
        return json(b);
      }
    }
    if (req.method === "POST" && path.startsWith("v1/humans/")) {
      requireSameOrigin(req);
      const ip =
        req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
        "local";
      await limitPaymentAuth(`human-ip:${ip}`, 60);
      if (path === "v1/humans/register") {
        await limitPaymentAuth("human-register-global", 120);
        const result = await createHuman(humanProfile.parse(await body(req)));
        return sessionJson(
          {
            profile: result.profile,
            recoveryCode: result.token,
            message:
              "Save this recovery code privately. It is shown only once.",
          },
          result.token,
          201,
        );
      }
      if (path === "v1/humans/recover") {
        const input = z
          .object({ recoveryCode: z.string().min(40).max(80) })
          .strict()
          .parse(await body(req));
        const result = await recoverHuman(input.recoveryCode);
        return sessionJson({ profile: result.profile }, result.token);
      }
      if (path === "v1/humans/bets") {
        const human = await authenticateHuman(req);
        return json(
          await createHumanBet(
            human!.agent_id,
            humanBet.parse(await body(req)),
          ),
          402,
        );
      }
      if (/^v1\/humans\/bets\/[0-9a-f-]+\/confirm$/.test(path)) {
        const human = await authenticateHuman(req);
        const id = z.uuid().parse(path.split("/")[3]);
        const result = await confirmHumanBet(human!.agent_id, id);
        return json(result.body, result.httpStatus);
      }
    }
    if (req.method === "POST" && path.startsWith("v1/payment-auth/")) {
      const ip =
        req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
        "local";
      await limitPaymentAuth(`ip:${ip}`, 60);
      await limitPaymentAuth("global", 300);
      if (path === "v1/payment-auth/challenge")
        return json(
          await requestPayment(paymentProposal.parse(await body(req))),
          402,
        );
      if (path === "v1/payment-auth/confirm") {
        const input = confirmation.parse(await body(req));
        const result = await confirmPayment(input.challengeId, input.signature);
        return json(result.body, result.httpStatus);
      }
    }
    if (req.method === "POST" && path === "v1/bets") {
      const agent = (await authenticate(req, true))!;
      return json(
        await createIntent(agent, intent.parse(await body(req))),
        201,
      );
    }
    throw new ApiError(404, "Endpoint not found");
  } catch (e) {
    if (e instanceof ApiError)
      return json({ error: e.message, correlationId }, e.status);
    if (e instanceof z.ZodError)
      return json(
        {
          error: "Invalid request",
          issues: e.issues.map((x) => ({ path: x.path, message: x.message })),
          correlationId,
        },
        400,
      );
    log("request_failed", { correlationId });
    return json(
      { error: "Service temporarily unavailable", correlationId },
      503,
    );
  }
}
export const GET = route;
export const POST = route;
function stream(req: Request) {
  const encoder = new TextEncoder();
  let stopped = false;
  let timer: NodeJS.Timeout;
  let cursor = 0;
  const readable = new ReadableStream({
    async start(controller) {
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", stop, { once: true });
      const send = (type: string, data: unknown, id?: number) => {
        if (!stopped)
          controller.enqueue(
            encoder.encode(
              `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
      };
      try {
        cursor = Number(
          (
            await pool.query(
              "SELECT coalesce(max(id),0) AS id FROM market_events",
            )
          ).rows[0].id,
        );
        const prior = Number(req.headers.get("last-event-id"));
        if (Number.isSafeInteger(prior) && prior > 0) cursor = prior;
        send("connected", { serverTime: new Date().toISOString() });
      } catch {
        stop();
        return;
      }
      let lastPrice = "";
      let heartbeat = 0;
      const poll = async () => {
        try {
          const events = (
            await pool.query(
              "SELECT id,type,round_id,created_at FROM market_events WHERE id>$1 ORDER BY id LIMIT 100",
              [cursor],
            )
          ).rows;
          for (const e of events) {
            cursor = Number(e.id);
            send(e.type, { roundId: e.round_id, time: e.created_at }, cursor);
          }
          const p = (
            await pool.query(
              "SELECT id,price::text,provider_at FROM price_observations WHERE provider=$1 ORDER BY id DESC LIMIT 1",
              [config.PRICE_PROVIDER],
            )
          ).rows[0];
          if (p && p.id !== lastPrice) {
            lastPrice = p.id;
            send("price_update", { price: p.price, time: p.provider_at });
          }
          if (Date.now() - heartbeat > config.SSE_HEARTBEAT_SECONDS * 1000) {
            heartbeat = Date.now();
            send("heartbeat", { time: new Date().toISOString() });
            send("health_changed", await health());
          }
        } catch {
          send("health_changed", { status: "degraded" });
        }
        if (!stopped) timer = setTimeout(poll, 1000);
      };
      await poll();
    },
    cancel() {
      stopped = true;
      clearTimeout(timer);
    },
  });
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
