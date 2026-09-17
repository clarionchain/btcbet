"use client";
import { FormEvent, useCallback, useEffect, useState } from "react";

const api = "/btcbet/api/v1/humans";
const short = (value: string) =>
  value.length > 28 ? `${value.slice(0, 15)}…${value.slice(-10)}` : value;
const statusText = (value: string) => value.replaceAll("_", " ");

export default function HumanBet({
  round,
  amounts,
  phase,
  onChanged,
}: {
  round: any;
  amounts: number[];
  phase: string;
  onChanged: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<any>(null);
  const [payment, setPayment] = useState<any>(null);
  const [direction, setDirection] = useState<"UP" | "DOWN">("UP");
  const [amount, setAmount] = useState(amounts[0] ?? 1000);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recovering, setRecovering] = useState(false);

  const loadMe = useCallback(async () => {
    const response = await fetch(`${api}/me`, { cache: "no-store" });
    if (response.ok) {
      const next = await response.json();
      setMe(next);
      const pending = next.bets?.find(
        (bet: any) =>
          bet.status === "AWAITING_PAYMENT" &&
          +new Date(bet.response.paymentExpiration) > Date.now(),
      );
      if (pending)
        setPayment((current: any) =>
          current?.betId === pending.id
            ? current
            : {
                betId: pending.id,
                direction: pending.direction,
                payment: {
                  destination: pending.response.paymentRequest,
                  amountSats: Number(pending.amount),
                  expiresAt: pending.response.paymentExpiration,
                },
                qrUrl: `${api}/bets/${pending.id}/qr`,
              },
        );
    } else if (response.status === 401) setMe(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);
  useEffect(() => {
    if (!payment?.betId) return;
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch(`${api}/bets/${payment.betId}/confirm`, {
          method: "POST",
        });
        const result = await response.json();
        if (!stopped && response.status !== 402) {
          setMessage(result.message ?? statusText(result.status));
          if (result.accepted || result.status !== "AWAITING_PAYMENT") {
            setPayment(null);
            await loadMe();
            onChanged();
            return;
          }
        }
      } catch {}
      if (!stopped) window.setTimeout(check, 2000);
    };
    const timer = window.setTimeout(check, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [payment?.betId, loadMe, onChanged]);

  const post = async (path: string, value: unknown) => {
    const response = await fetch(api + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok && response.status !== 402)
      throw Error(result.error ?? "Request failed");
    return result;
  };
  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const result = await post("/register", {
        name: form.get("name"),
        returnAddress: form.get("returnAddress"),
      });
      setRecoveryCode(result.recoveryCode);
      await loadMe();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recover = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await post("/recover", { recoveryCode: form.get("recoveryCode") });
      setRecovering(false);
      await loadMe();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const place = async () => {
    if (!round?.id) return;
    setBusy(true);
    setMessage("");
    try {
      setPayment(
        await post("/bets", {
          roundId: round.id,
          direction,
          amountSats: amount,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied`);
  };

  if (loading)
    return (
      <section className="panel human-bet">
        <p>Loading player…</p>
      </section>
    );
  return (
    <section className="panel human-bet" id="bet">
      <div className="panel-title">
        <div>
          <h2>Place a bet with Keel</h2>
          <span className="muted">No agent required · signet sats only</span>
        </div>
        {me && <span className="player-chip">Human · {me.profile.name}</span>}
      </div>
      {!me ? (
        <div className="human-setup">
          {recovering ? (
            <form onSubmit={recover}>
              <label>
                Recovery code
                <input
                  name="recoveryCode"
                  required
                  autoComplete="off"
                  placeholder="btch_…"
                />
              </label>
              <button disabled={busy}>Restore player</button>
              <button
                type="button"
                className="text-button"
                onClick={() => setRecovering(false)}
              >
                Create a new player
              </button>
            </form>
          ) : (
            <form onSubmit={register}>
              <label>
                Display name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={40}
                  placeholder="Satoshi"
                />
              </label>
              <label>
                Keel payout and refund address
                <input
                  name="returnAddress"
                  required
                  autoComplete="off"
                  placeholder="tark1…"
                />
              </label>
              <p>
                Get a fresh receive address from Keel. BTCBet never receives
                your wallet keys.
              </p>
              <button disabled={busy}>Create player</button>
              <button
                type="button"
                className="text-button"
                onClick={() => setRecovering(true)}
              >
                Restore with recovery code
              </button>
            </form>
          )}
        </div>
      ) : payment ? (
        <div className="payment-step">
          <div className="qr-wrap">
            <img src={payment.qrUrl} alt="Keel Ark payment address QR code" />
          </div>
          <div className="payment-details">
            <span className="step-label">1 · Scan with Keel</span>
            <strong>
              {payment.direction === "UP" ? "↗ UP" : "↘ DOWN"} ·{" "}
              {Number(payment.payment.amountSats).toLocaleString()} sats
            </strong>
            <p>
              The QR contains the Ark address. Enter exactly{" "}
              <b>{Number(payment.payment.amountSats).toLocaleString()} sats</b>{" "}
              in Keel, review, and send once.
            </p>
            <code title={payment.payment.destination}>
              {short(payment.payment.destination)}
            </code>
            <div className="payment-actions">
              <button
                onClick={() =>
                  void copy(payment.payment.destination, "Address")
                }
              >
                Copy address
              </button>
              <button
                onClick={() =>
                  void copy(String(payment.payment.amountSats), "Amount")
                }
              >
                Copy amount
              </button>
              <a href={payment.keelUrl ?? "https://clarionlab.dev/keel"}>
                Open Keel ↗
              </a>
            </div>
            <span className="waiting">● Waiting for payment confirmation</span>
            <small>
              Expires {new Date(payment.payment.expiresAt).toLocaleTimeString()}
              . Do not send twice if confirmation takes a moment.
            </small>
          </div>
        </div>
      ) : (
        <div className="bet-builder">
          <div>
            <span className="step-label">1 · Choose a side</span>
            <div className="human-directions">
              <button
                className={direction === "UP" ? "selected up-button" : ""}
                onClick={() => setDirection("UP")}
              >
                ↗ UP
              </button>
              <button
                className={direction === "DOWN" ? "selected down-button" : ""}
                onClick={() => setDirection("DOWN")}
              >
                ↘ DOWN
              </button>
            </div>
          </div>
          <div>
            <span className="step-label">2 · Choose stake</span>
            <div className="human-amounts">
              {amounts.map((value) => (
                <button
                  key={value}
                  className={amount === value ? "selected" : ""}
                  onClick={() => setAmount(value)}
                >
                  {value.toLocaleString()} sats
                </button>
              ))}
            </div>
          </div>
          <div className="place-column">
            <span className="step-label">3 · Pay with Keel</span>
            <button
              className="place-bet"
              disabled={busy || phase !== "OPEN"}
              onClick={place}
            >
              {phase === "OPEN"
                ? `Create ${direction} payment`
                : "Betting is closed"}
            </button>
            <small>Returns go to {short(me.profile.returnAddress)}</small>
          </div>
        </div>
      )}
      {recoveryCode && (
        <div className="recovery-box">
          <strong>Save your recovery code</strong>
          <p>
            This restores your player, bet history, and ranking in another
            browser. Anyone with it can access your player.
          </p>
          <code>{recoveryCode}</code>
          <button onClick={() => void copy(recoveryCode, "Recovery code")}>
            Copy recovery code
          </button>
          <button className="text-button" onClick={() => setRecoveryCode("")}>
            I saved it
          </button>
        </div>
      )}
      {message && <div className="human-message">{message}</div>}
      {me?.bets?.length > 0 && !payment && (
        <div className="my-bets">
          <strong>My recent bets</strong>
          {me.bets.slice(0, 5).map((bet: any) => (
            <div key={bet.id}>
              <span className={bet.direction === "UP" ? "up" : "down"}>
                {bet.direction === "UP" ? "↗" : "↘"} {bet.direction}
              </span>
              <span>{Number(bet.amount).toLocaleString()} sats</span>
              <span className="status-tag">{statusText(bet.status)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
