import { pool } from "./db";
import { config } from "./config";
import { SecondArkPaymentAdapter } from "./second-ark";
export { SecondArkPaymentAdapter } from "./second-ark";
export type ReceiveRequest = { reference: string; paymentRequest: string };
export type Incoming = { id: string; amount: string; receivedAt: string };
export interface ArkPaymentAdapter {
  createReceiveRequest(input: {
    reference: string;
    amount: string;
  }): Promise<ReceiveRequest>;
  lookupIncomingPayment(reference: string): Promise<Incoming[]>;
  sendPayment(input: {
    reference: string;
    amount: string;
    destination: string;
  }): Promise<{ id: string; confirmed: boolean }>;
  getWalletStatus(): Promise<{ ready: boolean; mode: string; detail: string }>;
  getBalance(): Promise<{ sats: string }>;
  prepareReconciliation?(): Promise<void>;
  validateDestination(destination: string): boolean | Promise<boolean>;
}
export class MockArkPaymentAdapter implements ArkPaymentAdapter {
  validateDestination(d: string) {
    return /^mock-signet:[a-zA-Z0-9_-]{3,100}$/.test(d);
  }
  async createReceiveRequest(i: { reference: string; amount: string }) {
    return {
      reference: i.reference,
      paymentRequest: `mock-signet:${i.reference}?amount=${i.amount}`,
    };
  }
  async lookupIncomingPayment(reference: string) {
    return (
      await pool.query(
        'SELECT id,amount::text,received_at AS "receivedAt" FROM mock_receipts WHERE reference=$1 ORDER BY received_at,id',
        [reference],
      )
    ).rows;
  }
  async sendPayment(i: {
    reference: string;
    amount: string;
    destination: string;
  }) {
    const id = `mock:${i.reference}`;
    await pool.query(
      "INSERT INTO mock_sends(reference,provider_id,amount,destination) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [i.reference, id, i.amount, i.destination],
    );
    const row = (
      await pool.query("SELECT * FROM mock_sends WHERE reference=$1", [
        i.reference,
      ])
    ).rows[0];
    if (row.amount !== i.amount || row.destination !== i.destination)
      throw Error("Idempotency conflict");
    return { id: row.provider_id, confirmed: true };
  }
  async getWalletStatus() {
    return {
      ready: true,
      mode: "mock",
      detail: "Simulated signet payments; no Ark funds move",
    };
  }
  async getBalance() {
    return { sats: "0" };
  }
}
export const ark: ArkPaymentAdapter =
  config.ARK_ADAPTER === "mock"
    ? new MockArkPaymentAdapter()
    : new SecondArkPaymentAdapter();
