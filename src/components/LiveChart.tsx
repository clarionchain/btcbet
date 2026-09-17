"use client";
import { useEffect, useRef, useState } from "react";
type Point = { time: string; price: string };
type Frame = { time: number; price: number; low: number; high: number };
const usd = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const stamp = (n: number) =>
  new Date(n).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export default function LiveChart({
  observations,
  round,
}: {
  observations: Point[];
  round: any;
}) {
  const [full, setFull] = useState(false);
  const latest = observations.at(-1),
    at = latest ? +new Date(latest.time) : 0,
    price = latest ? Number(latest.price) : 0;
  const start = round ? +new Date(round.start_at) : 0,
    end = round ? +new Date(round.end_at) : 0;
  const opening = round?.opening == null ? null : Number(round.opening);
  const visible = observations.filter(
    (p) => full || +new Date(p.time) >= at - 60000,
  );
  const values = visible.map((p) => Number(p.price));
  if (full && opening !== null) values.push(opening);
  const lo = values.length ? Math.min(...values) : 0,
    hi = values.length ? Math.max(...values) : 1,
    pad = Math.max((hi - lo) * 0.18, 2);
  const target = { time: at, price, low: lo - pad, high: hi + pad };
  const [frame, setFrame] = useState<Frame>(target),
    current = useRef(target),
    roundId = useRef(round?.id);
  useEffect(() => {
    let animation: number;
    const to = { time: at, price, low: lo - pad, high: hi + pad },
      from = current.current;
    if (
      !from.time ||
      roundId.current !== round?.id ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      roundId.current = round?.id;
      current.current = to;
      setFrame(to);
      return;
    }
    const begin = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - begin) / 650),
        ease = 1 - (1 - t) ** 3;
      const next = {
        time: from.time + (to.time - from.time) * ease,
        price: from.price + (to.price - from.price) * ease,
        low: from.low + (to.low - from.low) * ease,
        high: from.high + (to.high - from.high) * ease,
      };
      current.current = next;
      setFrame(next);
      if (t < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animation);
  }, [at, price, lo, hi, pad, round?.id]);
  const right = full ? end : Math.min(end || Infinity, frame.time + 2000),
    left = full ? start : Math.max(start, right - 60000),
    span = Math.max(1000, right - left);
  const x = (t: number) => 30 + ((t - left) / span) * 810,
    y = (p: number) =>
      300 - ((p - frame.low) / Math.max(0.01, frame.high - frame.low)) * 270;
  const points = observations
    .filter(
      (p) =>
        +new Date(p.time) >= left - 2000 && +new Date(p.time) <= frame.time,
    )
    .map((p) => ({ time: +new Date(p.time), price: Number(p.price) }));
  if (latest) points.push({ time: frame.time, price: frame.price });
  const line = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${x(p.time).toFixed(2)},${y(p.price).toFixed(2)}`,
    )
    .join(" ");
  const targetY =
    opening === null ? null : Math.max(30, Math.min(300, y(opening)));
  return (
    <div className="live-chart-shell">
      <div className="chart-mode" aria-label="Chart time range">
        <button aria-pressed={!full} onClick={() => setFull(false)}>
          Live · 60s
        </button>
        <button aria-pressed={full} onClick={() => setFull(true)}>
          Full round
        </button>
        <span>UTC · updates every second</span>
      </div>
      <div
        className="chart"
        data-testid="live-chart"
        data-range={full ? "round" : "live"}
        aria-label="Live BTC price chart"
      >
        <svg
          viewBox="0 0 960 350"
          role="img"
          aria-label="Scrolling BTC price trace and price to beat"
        >
          <defs>
            <clipPath id="live-plot">
              <rect x="30" y="18" width="810" height="295" />
            </clipPath>
          </defs>
          {[30, 97.5, 165, 232.5, 300].map((v) => (
            <g key={v}>
              <line x1="30" x2="840" y1={v} y2={v} stroke="#242b36" />
              <text x="854" y={v + 5} fill="#94a2b8" fontSize="14">
                {latest
                  ? usd(
                      frame.low + ((300 - v) / 270) * (frame.high - frame.low),
                    )
                  : ""}
              </text>
            </g>
          ))}
          <g clipPath="url(#live-plot)">
            {round && (
              <>
                <rect
                  x={x(end - (round.rules?.closeWindowSeconds ?? 5) * 1000)}
                  y="18"
                  width={Math.max(
                    0,
                    x(end) -
                      x(end - (round.rules?.closeWindowSeconds ?? 5) * 1000),
                  )}
                  height="295"
                  fill="#94a2b8"
                  opacity=".08"
                />
                <line
                  x1={x(+new Date(round.lock_at))}
                  x2={x(+new Date(round.lock_at))}
                  y1="18"
                  y2="313"
                  stroke="#667185"
                  strokeDasharray="4 5"
                />
                <line
                  x1={x(end)}
                  x2={x(end)}
                  y1="18"
                  y2="313"
                  stroke="#667185"
                />
              </>
            )}
            {latest && (
              <>
                <line
                  x1="30"
                  x2="840"
                  y1={y(frame.price)}
                  y2={y(frame.price)}
                  stroke="#ffab16"
                  strokeDasharray="5 7"
                  opacity=".55"
                />
                <path
                  data-testid="price-trace"
                  d={line}
                  fill="none"
                  stroke="#ffab16"
                  strokeWidth="2.8"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle
                  cx={x(frame.time)}
                  cy={y(frame.price)}
                  r="10"
                  fill="#ffab16"
                  fillOpacity=".08"
                  stroke="#ffab16"
                  strokeOpacity=".4"
                />
                <circle
                  data-testid="live-price-dot"
                  cx={x(frame.time)}
                  cy={y(frame.price)}
                  r="4"
                  fill="#ffab16"
                />
              </>
            )}
          </g>
          {targetY !== null && (
            <g data-testid="chart-target">
              <line
                x1="30"
                x2="840"
                y1={targetY}
                y2={targetY}
                stroke="#7d8c9f"
                strokeDasharray="6 6"
              />
              <rect
                x="753"
                y={targetY - 12}
                width="87"
                height="24"
                rx="7"
                fill="#516074"
              />
              <text
                x="796"
                y={targetY + 5}
                textAnchor="middle"
                fontSize="14"
                fill="white"
              >
                Target {y(opening!) < 30 ? "↑" : y(opening!) > 300 ? "↓" : ""}
              </text>
            </g>
          )}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <text
              key={f}
              x={30 + f * 810}
              y="337"
              fill="#94a2b8"
              fontSize="14"
              textAnchor="middle"
            >
              {latest ? stamp(left + span * f) : "—"}
            </text>
          ))}
        </svg>
        {!latest && (
          <div className="chart-empty">
            Waiting for authoritative price observations
          </div>
        )}
      </div>
    </div>
  );
}
