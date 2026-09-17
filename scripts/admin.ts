import { randomBytes, randomUUID } from "node:crypto";
import { pool, tx, event } from "../src/lib/db";
import { tokenHash } from "../src/lib/auth";
import { ark } from "../src/lib/ark";
import { health } from "../src/lib/read";
import { settle } from "../src/lib/engine";
const [cmd, arg, address, ...flags] = process.argv.slice(2);
const confirmed = process.argv.includes("--confirm");
try {
  if (cmd === "create") {
    if (
      !arg ||
      arg.length > 60 ||
      !(await ark.validateDestination(address ?? ""))
    )
      throw Error('Usage: admin create "Agent name" mock-signet:destination');
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID();
    await tx(async (db) => {
      await db.query(
        "INSERT INTO agents(id,name,token_hash,return_address) VALUES($1,$2,$3,$4)",
        [id, arg, tokenHash(token), address],
      );
      await event(db, "agent_created", null, { agentId: id });
    });
    console.log(
      JSON.stringify({ id, token, note: "Shown once. Store privately." }),
    );
  } else if (cmd === "list") {
    console.table(
      (await pool.query("SELECT id,name,enabled,created_at FROM agents")).rows,
    );
  } else if (cmd === "status") {
    console.log(JSON.stringify(await health(), null, 2));
    console.table(
      (
        await pool.query(
          "SELECT id,status,attempts,last_error FROM outgoing_payments WHERE status!='CONFIRMED'",
        )
      ).rows,
    );
  } else if (cmd === "wallet") {
    console.log(await ark.getWalletStatus());
    console.log(await ark.getBalance());
  } else if (
    [
      "enable",
      "disable",
      "rotate",
      "revoke",
      "pause",
      "resume",
      "retry",
      "void",
    ].includes(cmd)
  ) {
    if (!confirmed)
      throw Error("This action requires --confirm and is audited");
    if (cmd === "void") {
      const c = await pool.connect();
      try {
        await c.query("SELECT pg_advisory_lock(7285301)");
        const r = (await c.query("SELECT phase FROM rounds WHERE id=$1", [arg]))
          .rows[0];
        if (!r || !["OPEN", "LOCKED"].includes(r.phase))
          throw Error("Only unresolved rounds can be voided");
        await settle(arg, new Date(), "Administrator void");
        await event(c, "admin_void", arg);
      } finally {
        await c.query("SELECT pg_advisory_unlock(7285301)");
        c.release();
      }
    } else
      await tx(async (db) => {
        let token: string | undefined;
        if (cmd === "enable" || cmd === "disable")
          await db.query("UPDATE agents SET enabled=$2 WHERE id=$1", [
            arg,
            cmd === "enable",
          ]);
        if (cmd === "rotate" || cmd === "revoke") {
          await db.query(
            "UPDATE payment_sessions SET revoked=true WHERE agent_id=$1",
            [arg],
          );
          token = randomBytes(32).toString("base64url");
          await db.query("UPDATE agents SET token_hash=$2 WHERE id=$1", [
            arg,
            tokenHash(token),
          ]);
        }
        if (cmd === "pause" || cmd === "resume")
          await db.query(
            "UPDATE system_settings SET value=$1,updated_at=now() WHERE key='paused'",
            [JSON.stringify(cmd === "pause")],
          );
        if (cmd === "retry")
          await db.query(
            "UPDATE outgoing_payments SET status='PENDING',attempts=0,next_attempt_at=now() WHERE id=$1 AND status='FAILED'",
            [arg],
          );
        await event(db, `admin_${cmd}`, null, { target: arg ?? null });
        if (cmd === "rotate")
          console.log(JSON.stringify({ token, note: "Shown once" }));
      });
    console.log("Done");
  } else
    throw Error(
      "Commands: create, list, enable, disable, rotate, revoke, status, wallet, pause, resume, retry, void",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Command failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
