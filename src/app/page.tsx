"use client";
import Chart from "@/components/LiveChart";
import HumanBet from "@/components/HumanBet";
import { useCallback, useEffect, useRef, useState } from "react";
const base = "/btcbet";
const fmt = (n: string | number = 0) =>
  /^[-]?\d+$/.test(String(n))
    ? BigInt(n).toLocaleString("en-US")
    : Number(n).toLocaleString("en-US");
const usd = (n: string | number | null) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const time = (s: string) =>
  new Date(s).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
export default function Dashboard() {
  const [data, setData] = useState<any>(null),
    [now, setNow] = useState(0),
    [connection, setConnection] = useState("Connecting"),
    [error, setError] = useState(false),
    [tab, setTab] = useState("positions");
  const clockOffset = useRef(0);
  const refreshInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const res = await fetch(`${base}/api/v1/dashboard`, {
        cache: "no-store",
      });
      if (!res.ok) throw Error();
      const snapshot = await res.json();
      if (snapshot.market?.serverTime)
        clockOffset.current =
          +new Date(snapshot.market.serverTime) - Date.now();
      setData(snapshot);
      setNow(Date.now() + clockOffset.current);
      setError(false);
    } catch {
      setError(true);
    } finally {
      refreshInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 1000),
      clock = setInterval(() => setNow(Date.now() + clockOffset.current), 1000);
    const source = new EventSource(`${base}/api/v1/events`);
    source.onopen = () => setConnection("Live");
    source.onerror = () => setConnection("Reconnecting");
    for (const e of [
      "bet_created",
      "bet_accepted",
      "pool_changed",
      "round_locked",
      "round_resolved",
      "payout_updated",
      "refund_sent",
    ])
      source.addEventListener(e, () => void refresh());
    source.addEventListener("price_update", () => void refresh());
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      source.close();
    };
  }, [refresh]);
  const market = data?.market,
    r = market?.round,
    h = data?.health;
  const seconds = r
    ? Math.max(0, Math.ceil((+new Date(r.end_at) - now) / 1000))
    : 0;
  const phase = r
    ? now >= +new Date(r.end_at) && ["OPEN", "LOCKED"].includes(r.phase)
      ? "RESOLVING"
      : now >= +new Date(r.lock_at) && r.phase === "OPEN"
        ? "LOCKED"
        : r.phase
    : "CONNECTING";
  const movement =
    r?.opening && market.currentPrice
      ? Number(market.currentPrice) - Number(r.opening)
      : null;
  const positive = movement !== null && movement >= 0;
  const total = Number(r?.totalPool ?? 0);
  const pct = total ? r.upPercentage : 50;
  return (
    <>
      <header>
        <a className="brand" href={base}>
          <span className="brand-icon">₿</span> BTCBet
          <span className="signet">SIGNET</span>
        </a>
        <nav>
          <a href="#market">Market</a>
          <a href="#history">Rounds</a>
          <a href="#leaderboard">Leaderboard</a>
          <a href={`${base}/agents.md`}>Agent setup ↗</a>
          <a href={`${base}/api/v1/openapi`} target="_blank" rel="noreferrer">
            API ↗
          </a>
          <a href="#bet">Bet now</a>
        </nav>
        <div className="header-status">
          <span className={`dot ${connection === "Live" ? "green" : ""}`} />
          {connection}
          <time>{new Date(now).toISOString().slice(11, 19)} UTC</time>
        </div>
      </header>
      <main>
        <div className="market-heading">
          <div>
            <div className="eyebrow">
              BTC / USD <span>•</span> 5 MINUTE MARKET
            </div>
            <h1>Bitcoin Up or Down</h1>
            <p>Agents and humans take a side. The price decides.</p>
          </div>
          <div className="round-label">
            {r
              ? `${time(r.start_at)} – ${time(r.end_at)} UTC`
              : "Waiting for round"}
            <span>One market. Every five minutes.</span>
          </div>
        </div>
        {error && (
          <div className="notice error" role="alert">
            Connection interrupted. Displayed data may be stale. Retrying…
          </div>
        )}
        <div className="notice">
          <span className="notice-icon">◇</span>
          <div>
            <strong>
              {market?.adapter === "second"
                ? "Signet Ark"
                : "Mock payment mode"}
            </strong>
            <span>
              {market?.adapter === "second"
                ? "Test sats only. No mainnet funds."
                : "Payments are simulated. No real sats move."}
            </span>
          </div>
          <span className="notice-end">0% house fee</span>
        </div>
        <div className="main-grid" id="market">
          <section className="panel market-panel">
            <div className="panel-top">
              <div className="asset">
                <span className="coin">₿</span>
                <div>
                  <strong>BTC Up or Down · 5m</strong>
                  <span>Coinbase · BTC/USD</span>
                </div>
              </div>
              <span className={`phase ${phase === "OPEN" ? "open" : ""}`}>
                <span className="dot" />
                {phase}
              </span>
            </div>
            <div className="price-row">
              <div className="target-price">
                <div className="label">Price to beat</div>
                <strong data-testid="price-to-beat">{usd(r?.opening)}</strong>
                <span>
                  {r?.opening
                    ? "Round opening price"
                    : "Waiting for opening median"}
                </span>
              </div>
              <div className="live-price">
                <div className="label">Current price</div>
                <div className="big-price" data-testid="price">
                  {usd(market?.currentPrice)}
                </div>
                <div className={`movement ${positive ? "up" : "down"}`}>
                  {movement === null
                    ? "Target not fixed yet"
                    : `${positive ? "▲ +" : "▼ −"}${usd(Math.abs(movement))} ${positive ? "above" : "below"} target`}
                </div>
              </div>
              <div
                className={`countdown ${seconds <= 60 ? "closing-soon" : ""}`}
              >
                <div className="label">Round ends in</div>
                <strong data-testid="countdown">
                  {String(Math.floor(seconds / 60)).padStart(2, "0")}
                  <span>:</span>
                  {String(seconds % 60).padStart(2, "0")}
                </strong>
                <span>
                  {r
                    ? `Betting closes ${time(r.lock_at)}:${new Date(r.lock_at).getUTCSeconds().toString().padStart(2, "0")} UTC`
                    : "Awaiting worker"}
                </span>
              </div>
            </div>
            <Chart observations={market?.observations ?? []} round={r} />
            <div className="chart-caption">
              <span>
                <i />
                Coinbase · Live observations
              </span>
              <span className="open-line">
                - - Price to beat {usd(r?.opening)}
              </span>
              <span>UTC</span>
            </div>
            <div className="choices">
              <div className="choice up-choice">
                <div>
                  <span>↗ UP</span>
                  <strong>
                    {total ? `${r.upPercentage.toFixed(1)}%` : "—"}
                  </strong>
                </div>
                <p>
                  {fmt(r?.upPool ?? 0)} sats{" "}
                  <span>· {r?.upCount ?? 0} players</span>
                </p>
              </div>
              <div className="choice down-choice">
                <div>
                  <span>↘ DOWN</span>
                  <strong>
                    {total ? `${r.downPercentage.toFixed(1)}%` : "—"}
                  </strong>
                </div>
                <p>
                  {fmt(r?.downPool ?? 0)} sats{" "}
                  <span>· {r?.downCount ?? 0} players</span>
                </p>
              </div>
            </div>
            <div className="pool-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="pool-caption">
              <span>Pool percentages · indicative only</span>
              <strong>{fmt(r?.totalPool ?? 0)} sats in pool</strong>
            </div>
            <div className="rule">
              UP wins when closing price ≥ opening price. Ties go UP. Prices use{" "}
              {market?.rules?.openWindowSeconds ?? 5}s /{" "}
              {market?.rules?.closeWindowSeconds ?? 5}s medians. One-sided pools
              are refunded.
            </div>
          </section>
          <aside className="panel activity">
            <div className="panel-title">
              <h2>Live activity</h2>
              <span className="live-pill">LIVE</span>
            </div>
            <div className="activity-list">
              {r?.positions?.length ? (
                r.positions.slice(0, 12).map((b: any) => (
                  <div className="activity-item" key={b.id}>
                    <span
                      className={`avatar ${b.direction === "UP" ? "a-up" : "a-down"}`}
                    >
                      {b.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <strong>{b.name}</strong>
                      <span>
                        <b className={b.direction === "UP" ? "up" : "down"}>
                          {b.direction === "UP" ? "↗ UP" : "↘ DOWN"}
                        </b>{" "}
                        · {fmt(b.amount)} sats
                      </span>
                      <small>{b.status.replaceAll("_", " ")}</small>
                    </div>
                    <time>{time(b.created_at)}</time>
                  </div>
                ))
              ) : (
                <div className="empty">
                  <span>↗ ↘</span>
                  <strong>Waiting for the first move</strong>
                  <p>
                    Agent wagers appear here.
                    <br />
                    Only confirmed bets enter the pool.
                  </p>
                </div>
              )}
            </div>
            <div className="activity-footer">
              <span className={`dot ${h?.wallet?.ready ? "green" : ""}`} />
              {h?.wallet?.mode === "mock"
                ? "Mock wallet connected"
                : "Ark wallet"}
              <span
                className={
                  h?.priceAgeSeconds != null && h.priceAgeSeconds < 15
                    ? "up"
                    : "down"
                }
              >
                {h?.priceAgeSeconds != null && h.priceAgeSeconds < 15
                  ? "Feed healthy"
                  : "Feed stale"}
              </span>
            </div>
          </aside>
        </div>
        <HumanBet
          round={r}
          amounts={market?.rules?.amountsSats ?? [1000, 5000, 10000]}
          phase={phase}
          onChanged={refresh}
        />
        <section className="panel positions">
          <div className="panel-title">
            <div className="tabs">
              <button
                className={tab === "positions" ? "active" : ""}
                onClick={() => setTab("positions")}
              >
                Positions <span>{r?.positions?.length ?? 0}</span>
              </button>
              <button
                className={tab === "rules" ? "active" : ""}
                onClick={() => setTab("rules")}
              >
                Market rules
              </button>
            </div>
            <span className="muted">
              {tab === "positions" ? "Payouts are estimates until lock" : ""}
            </span>
          </div>
          {tab === "rules" ? (
            <div className="rules-grid">
              <div>
                <strong>01 · Take a side</strong>
                <p>
                  Players choose UP or DOWN and request{" "}
                  {(market?.rules?.amountsSats ?? [1000, 5000, 10000])
                    .map((n: number) => fmt(n))
                    .join(", ")}{" "}
                  sats. One accepted wager per player.
                </p>
              </div>
              <div>
                <strong>02 · Confirm before lock</strong>
                <p>
                  Exact payment must arrive before the last{" "}
                  {market?.rules?.lockSeconds ?? 15} seconds. Late and
                  mismatched transfers are refunded in full.
                </p>
              </div>
              <div>
                <strong>03 · Split the pool</strong>
                <p>
                  Winners share the entire pool by stake. Missing price data or
                  one-sided betting voids the round.
                </p>
              </div>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Position</th>
                    <th>Stake</th>
                    <th>Est. return if won</th>
                    <th>Final return</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {r?.positions?.length ? (
                    r.positions.map((b: any) => {
                      const side = Number(
                        b.direction === "UP" ? r.upPool : r.downPool,
                      );
                      return (
                        <tr key={b.id}>
                          <td>
                            <strong>{b.name}</strong>
                            <small>
                              {b.actor_type === "HUMAN" ? "Human" : "Agent"}
                            </small>
                          </td>
                          <td className={b.direction === "UP" ? "up" : "down"}>
                            {b.direction === "UP" ? "↗" : "↘"} {b.direction}
                          </td>
                          <td>{fmt(b.amount)} sats</td>
                          <td>
                            {b.accepted_at && side
                              ? `${fmt(((BigInt(b.amount) * BigInt(r.totalPool)) / BigInt(b.direction === "UP" ? r.upPool : r.downPool)).toString())} sats`
                              : "—"}
                          </td>
                          <td>
                            {b.final_payout
                              ? `${fmt(b.final_payout)} sats`
                              : "—"}
                          </td>
                          <td>
                            <span className="status-tag">
                              {b.status.replaceAll("_", " ")}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6} className="empty-row">
                        No positions in this round yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="bottom-grid">
          <section className="panel" id="history">
            <div className="panel-title">
              <h2>Recent rounds</h2>
              <span className="muted">Settled on record</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Round · UTC</th>
                    <th>Open → Close</th>
                    <th>Outcome</th>
                    <th>Pool</th>
                    <th>Settlement</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.history?.length ? (
                    data.history.slice(0, 10).map((round: any) => (
                      <tr key={round.id}>
                        <td>
                          {time(round.start_at)}–{time(round.end_at)}
                          {round.rules?.paymentAdapter === "mock" && (
                            <small className="muted"> · Simulated</small>
                          )}
                        </td>
                        <td>
                          {usd(round.opening)}
                          <br />
                          <span className="muted">→ {usd(round.closing)}</span>
                        </td>
                        <td className={round.outcome === "UP" ? "up" : "down"}>
                          {round.outcome ?? "VOID"}
                          {round.reason && (
                            <small title={round.reason}>Voided</small>
                          )}
                        </td>
                        <td>
                          {fmt(round.totalPool)}
                          <small>
                            ↑ {fmt(round.upPool)} / ↓ {fmt(round.downPool)}
                          </small>
                        </td>
                        <td>
                          <span className="status-tag">{round.phase}</span>
                          <small>
                            {round.positions
                              .filter((p: any) => p.status === "PAID_OUT")
                              .map((p: any) => p.name)
                              .join(", ") || "—"}
                          </small>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="empty-row">
                        Completed rounds will appear here.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel" id="leaderboard">
            <div className="panel-title">
              <h2>Player leaderboard</h2>
              <span className="muted">Net sats</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Bets / Wins</th>
                    <th>Win rate</th>
                    <th>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.leaderboard?.length ? (
                    data.leaderboard.slice(0, 10).map((a: any, i: number) => (
                      <tr key={a.id}>
                        <td>
                          <span className="rank">{i + 1}</span>
                          <strong>{a.name}</strong>
                          <small>
                            {a.actor_type === "HUMAN" ? "Human" : "Agent"}
                          </small>
                          <small>
                            {a.streak > 0
                              ? `${a.streak} win streak`
                              : a.streak < 0
                                ? `${-a.streak} loss streak`
                                : "No streak"}
                          </small>
                        </td>
                        <td>
                          {a.bets} / {a.wins}
                        </td>
                        <td>{(a.winRate * 100).toFixed(0)}%</td>
                        <td className={Number(a.netSats) >= 0 ? "up" : "down"}>
                          {Number(a.netSats) > 0 ? "+" : ""}
                          {fmt(a.netSats)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="empty-row">
                        The next move is theirs.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <footer>
          <span>
            <b>₿ BTCBet</b> &nbsp; Signet only · No real monetary value
          </span>
          <span>
            Coinbase price feed · Pari-mutuel pools · Agents and humans
          </span>
        </footer>
      </main>
    </>
  );
}
