// Local agent identity only. Never reads a Keel seed/private key.
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  randomUUID,
} from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
const base = process.env.BTCBET_URL ?? "https://clarionlab.dev/btcbet";
const [command, file = "agent-identity.json", returnAddress] =
  process.argv.slice(2);
if (command === "init") {
  const keys = generateKeyPairSync("ed25519");
  await writeFile(
    file,
    JSON.stringify({
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Identity saved privately. Next: payment-agent.mjs request IDENTITY_FILE ARK_RETURN_ADDRESS",
  );
} else {
  const state = JSON.parse(await readFile(file, "utf8")),
    privateKey = createPrivateKey(state.privateKey),
    publicKey = Buffer.from(
      createPublicKey(privateKey).export({ format: "jwk" }).x,
      "base64url",
    ).toString("hex");
  const signature = (message) =>
    sign(null, Buffer.from(message), privateKey).toString("hex");
  const post = async (path, body) => {
    const r = await fetch(base + "/api/v1" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  if (command === "request") {
    if (state.challenge)
      throw Error(
        "Existing challenge saved. Confirm it first; do not create duplicate payments.",
      );
    if (!returnAddress) throw Error("Provide your Keel Ark return address");
    const market = await (await fetch(base + "/api/v1/markets/current")).json();
    const p = state.proposal ?? {
      agentPublicKey: publicKey,
      name: process.env.BTCBET_AGENT_NAME ?? "Keel agent",
      roundId: market.round.id,
      direction: process.env.BTCBET_DIRECTION ?? "UP",
      amountSats: Number(process.env.BTCBET_AMOUNT ?? 1000),
      returnAddress,
      idempotencyKey: state.idempotencyKey ?? randomUUID(),
    };
    state.proposal = p;
    state.idempotencyKey = p.idempotencyKey;
    await writeFile(file, JSON.stringify(state), { mode: 0o600 });
    const r = await post("/payment-auth/challenge", {
      ...p,
      signature: signature(
        JSON.stringify([
          "btcbet:proposal:v1",
          base,
          p.agentPublicKey,
          p.name,
          p.roundId,
          p.direction,
          p.amountSats,
          p.returnAddress,
          p.idempotencyKey,
        ]),
      ),
    });
    if (r.status !== 402 || !r.body.challengeId)
      throw Error(JSON.stringify(r.body));
    state.challenge = r.body;
    await writeFile(file, JSON.stringify(state), { mode: 0o600 });
    await chmod(file, 0o600);
    console.log(
      JSON.stringify(
        {
          mode: r.body.mode,
          keel: r.body.keelUrl,
          payment: r.body.payment,
          betId: r.body.betId,
          note: "Authorize this exact payment once through Keel, then run confirm.",
        },
        null,
        2,
      ),
    );
  } else if (command === "confirm") {
    if (!state.challenge) throw Error("Request a challenge first");
    const c = state.challenge,
      r = await post("/payment-auth/confirm", {
        challengeId: c.challengeId,
        signature: signature(c.challenge),
      });
    if (r.status === 200) {
      state.accessToken = r.body.accessToken;
      state.expiresAt = r.body.expiresAt;
      await writeFile(file, JSON.stringify(state), { mode: 0o600 });
      console.log(
        JSON.stringify({
          status: r.body.status,
          betId: r.body.betId,
          expiresAt: r.body.expiresAt,
          note: "Session saved privately to identity file.",
        }),
      );
    } else console.log(JSON.stringify(r));
  } else if (command === "status") {
    if (!state.accessToken) throw Error("Confirm your paid challenge first");
    const r = await fetch(base + "/api/v1/bets/" + state.challenge.betId, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    console.log(await r.json());
  } else throw Error("Commands: init, request, confirm, status");
}
