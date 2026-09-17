import { describe, it, expect } from "vitest";
import {
  boundary,
  eligible,
  median,
  outcome,
  allocate,
  assertTransition,
  sameIntent,
} from "../src/lib/math";
import { parseConfig } from "../src/lib/config";
describe("market rules", () => {
  it("aligns UTC boundaries exactly", () => {
    expect(boundary(299999)).toBe(0);
    expect(boundary(300000)).toBe(300000);
    expect(boundary(Date.parse("2026-09-08T12:04:59Z"))).toBe(
      Date.parse("2026-09-08T12:00:00Z"),
    );
  });
  it("excludes the exact cutoff", () => {
    expect(eligible(284999, 285000)).toBe(true);
    expect(eligible(285000, 285000)).toBe(false);
  });
  it("calculates exact odd and even medians", () => {
    expect(median(["102", "100", "101"])).toBe("101.00000000");
    expect(median(["100.01", "100.02"])).toBe("100.01500000");
    expect(median([])).toBe(null);
  });
  it("resolves up, down and ties with decimal precision", () => {
    expect(outcome("100", "100")).toBe("UP");
    expect(outcome("100", "100.01")).toBe("UP");
    expect(outcome("100", "99.99999999")).toBe("DOWN");
  });
  it("conserves sats with deterministic largest remainder and ID tie break", () => {
    const result = allocate(
      [
        { id: "b", direction: "UP", amount: 2n },
        { id: "a", direction: "UP", amount: 2n },
        { id: "c", direction: "DOWN", amount: 1n },
      ],
      "UP",
    );
    expect(result.payouts).toEqual([
      { id: "a", amount: 3n },
      { id: "b", amount: 2n },
    ]);
  });
  it("handles values beyond float precision", () => {
    const n = 9007199254740993n;
    const p = allocate(
      [
        { id: "a", direction: "UP", amount: n },
        { id: "b", direction: "DOWN", amount: n },
      ],
      "UP",
    );
    expect(p.payouts[0].amount).toBe(n * 2n);
  });
  it("voids a one-sided pool but keeps empty round history", () => {
    expect(
      allocate([{ id: "a", direction: "DOWN", amount: 1000n }], "UP").voided,
    ).toBe(true);
    expect(allocate([], "UP").voided).toBe(false);
  });
  it("guards transitions and intent equality", () => {
    expect(() =>
      assertTransition("AWAITING_PAYMENT", "ACCEPTED"),
    ).not.toThrow();
    expect(() => assertTransition("PAID_OUT", "ACCEPTED")).toThrow();
    expect(sameIntent({ amount: 1 }, { amount: 2 })).toBe(false);
  });
  it("refuses mainnet and invalid timing", () => {
    expect(() =>
      parseConfig({ ...process.env, ARK_NETWORK: "bitcoin" }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...process.env, BETTING_LOCK_SECONDS: "300" }),
    ).toThrow();
  });
  it("treats empty env strings as unset", () => {
    const c = parseConfig({
      ...process.env,
      SSE_HEARTBEAT_SECONDS: "",
      BETTING_LOCK_SECONDS: "",
    });
    expect(c.SSE_HEARTBEAT_SECONDS).toBe(10);
    expect(c.BETTING_LOCK_SECONDS).toBe(15);
  });
  it("fills required secrets during next build when they are blank", () => {
    const c = parseConfig({
      NEXT_PHASE: "phase-production-build",
      DATABASE_URL: "",
      ADMIN_SECRET: "",
      AGENT_TOKEN_PEPPER: "",
      SSE_HEARTBEAT_SECONDS: "",
    });
    expect(c.DATABASE_URL.startsWith("postgres")).toBe(true);
    expect(c.SSE_HEARTBEAT_SECONDS).toBe(10);
  });
});
