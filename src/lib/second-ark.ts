import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { pool } from "./db";
import { config } from "./config";
import type { ArkPaymentAdapter, Incoming } from "./ark";
import init, { validateArkAddress } from "@secondts/bark/web";
let wasm: Promise<unknown> | undefined;
const decodeReady = () =>
  (wasm ??= (async () =>
    init({
      module_or_path: await readFile(
        "node_modules/@secondts/bark/web/bark_ffi_wasm_bg.wasm",
      ),
    }))());
type Movement = {
  id: number;
  status: string;
  time: { created_at: string; completed_at?: string };
  received_on: {
    destination: { type: string; value: string };
    amount_sat: number;
  }[];
  sent_to: {
    destination: { type: string; value: string };
    amount_sat: number;
  }[];
};
// Match a transfer only against the complete movement set recorded before this one exclusive send.
export function recoverSend(
  history: Movement[],
  before: number[],
  destination: string,
  amount: string,
) {
  return history.filter(
    (m) =>
      !before.includes(m.id) &&
      m.sent_to.some(
        (d) =>
          d.destination.type === "ark" &&
          d.destination.value === destination &&
          String(d.amount_sat) === amount,
      ),
  );
}
export function incomingFor(history: Movement[], address: string): Incoming[] {
  return history
    .filter((m) => m.status === "successful" && m.time.completed_at)
    .flatMap((m) =>
      m.received_on
        .filter(
          (d) =>
            d.destination.type === "ark" && d.destination.value === address,
        )
        .map((d) => ({
          id: `second:${m.id}:${address}`,
          amount: String(d.amount_sat),
          receivedAt: m.time.completed_at!,
        })),
    );
}
export class SecondArkPaymentAdapter implements ArkPaymentAdapter {
  private snapshot: Movement[] = [];
  private syncedAt = 0;
  private statusCache?: {
    at: number;
    value: { ready: boolean; mode: string; detail: string };
  };
  protected async cli(args: string[]) {
    if (!config.ARK_WALLET_CONFIG)
      throw Error("Dedicated house wallet not configured");
    return (
      await promisify(execFile)(
        "bark",
        [
          "--quiet",
          "--no-logfile",
          "--datadir",
          config.ARK_WALLET_CONFIG,
          ...args,
        ],
        { timeout: 45000, maxBuffer: 16 * 1024 * 1024 },
      )
    ).stdout.trim();
  }
  private async exclusive<T>(fn: () => Promise<T>) {
    const c = await pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(7285303)");
      return await fn();
    } finally {
      await c.query("SELECT pg_advisory_unlock(7285303)");
      c.release();
    }
  }
  async validateDestination(address: string) {
    await decodeReady();
    return address.startsWith("tark1") && validateArkAddress(address);
  }
  async createReceiveRequest(i: { reference: string; amount: string }) {
    return this.exclusive(async () => {
      const prior = (
        await pool.query(
          "SELECT address FROM ark_receive_requests WHERE reference=$1",
          [i.reference],
        )
      ).rows[0];
      if (prior)
        return { reference: i.reference, paymentRequest: prior.address };
      const address = await this.cli(["address"]);
      if (!(await this.validateDestination(address)))
        throw Error("Invalid house receive address");
      await pool.query(
        "INSERT INTO ark_receive_requests(reference,address) VALUES($1,$2)",
        [i.reference, address],
      );
      return { reference: i.reference, paymentRequest: address };
    });
  }
  async prepareReconciliation() {
    await this.exclusive(async () => {
      this.snapshot = JSON.parse(await this.cli(["history"]));
      this.syncedAt = Date.now();
    });
  }
  async lookupIncomingPayment(reference: string) {
    if (Date.now() - this.syncedAt > 5000) await this.prepareReconciliation();
    const row = (
      await pool.query(
        "SELECT address FROM ark_receive_requests WHERE reference=$1",
        [reference],
      )
    ).rows[0];
    return row ? incomingFor(this.snapshot, row.address) : [];
  }
  async sendPayment(i: {
    reference: string;
    amount: string;
    destination: string;
  }) {
    return this.exclusive(async () => {
      let op = (
        await pool.query(
          "SELECT * FROM ark_send_operations WHERE reference=$1",
          [i.reference],
        )
      ).rows[0];
      if (op && (op.amount !== i.amount || op.destination !== i.destination))
        throw Error("Outgoing reference conflict");
      if (op?.state === "CONFIRMED")
        return { id: op.provider_id, confirmed: true };
      let history: Movement[] = JSON.parse(await this.cli(["history"]));
      if (!op) {
        // No new transfer while any earlier operation has an unresolved external outcome.
        if (
          (
            await pool.query(
              "SELECT 1 FROM ark_send_operations WHERE state IN ('STARTED','UNKNOWN')",
            )
          ).rowCount
        )
          throw Error("House wallet has an unresolved send");
        const balance = JSON.parse(await this.cli(["balance", "--no-sync"]));
        if (BigInt(balance.spendable_sat) < BigInt(i.amount))
          throw Error("House wallet requires funding");
        const before = history.map((m) => m.id);
        await pool.query(
          "INSERT INTO ark_send_operations(reference,amount,destination,before_ids,state) VALUES($1,$2,$3,$4,'STARTED')",
          [i.reference, i.amount, i.destination, JSON.stringify(before)],
        );
        op = { before_ids: before };
        // Never invoke send a second time for this reference, even after timeout or process death.
        try {
          await this.cli(["send", i.destination, `${i.amount} sats`, "--wait"]);
        } catch {
          /* Reconcile evidence, never blindly resend. */
        }
        history = JSON.parse(await this.cli(["history"]));
      }
      const matches = recoverSend(
        history,
        op.before_ids,
        i.destination,
        i.amount,
      );
      if (matches.length === 1 && matches[0].status === "successful") {
        const id = `second-send:${matches[0].id}`;
        await pool.query(
          "UPDATE ark_send_operations SET state='CONFIRMED',provider_id=$2 WHERE reference=$1",
          [i.reference, id],
        );
        return { id, confirmed: true };
      }
      await pool.query(
        "UPDATE ark_send_operations SET state='UNKNOWN' WHERE reference=$1",
        [i.reference],
      );
      throw Error("Ark send outcome requires reconciliation; will not resend");
    });
  }
  async getWalletStatus() {
    if ((await pool.query("SELECT 1 FROM ark_send_operations WHERE state IN ('STARTED','UNKNOWN') LIMIT 1")).rowCount)
      return {ready: false, mode: "second", detail: "Ark outgoing payment requires reconciliation"};
    if (this.statusCache && Date.now() - this.statusCache.at < 10000)
      return this.statusCache.value;
    try {
      const value = await this.exclusive(async () => {
        const cfg = JSON.parse(await this.cli(["config"]));
        if (cfg.server_address !== config.ARK_SERVER_URL)
          throw Error("Ark server mismatch");
        const info = JSON.parse(await this.cli(["ark-info"]));
        if (info.network !== "signet") throw Error("Not signet");
        return {
          ready: true,
          mode: "second",
          detail: "Second signet house wallet connected",
        };
      });
      this.statusCache = { at: Date.now(), value };
      return value;
    } catch {
      return {
        ready: false,
        mode: "second",
        detail: "Second signet house wallet unavailable",
      };
    }
  }
  async getBalance() {
    return this.exclusive(async () => ({
      sats: String(
        JSON.parse(await this.cli(["balance", "--no-sync"])).spendable_sat,
      ),
    }));
  }
}
