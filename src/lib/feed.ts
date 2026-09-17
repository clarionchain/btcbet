import WebSocket from "ws";
import { pool, log } from "./db";
import { config } from "./config";
export interface PriceFeedAdapter {
  start(): void;
  stop(): void;
}
export class CoinbasePriceFeed implements PriceFeedAdapter {
  private socket?: WebSocket;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  start() {
    this.stopped = false;
    this.connect();
  }
  private connect() {
    if (this.stopped) return;
    const ws = (this.socket = new WebSocket(
      "wss://ws-feed.exchange.coinbase.com",
    ));
    let last = Date.now();
    ws.on("open", () => {
      log("price_feed_connected");
      ws.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: [config.PRICE_PAIR],
          channels: ["ticker", "heartbeat"],
        }),
      );
    });
    ws.on("message", (raw) => {
      last = Date.now();
      const receipt = new Date();
      try {
        const p = JSON.parse(raw.toString());
        if (
          p.type !== "ticker" ||
          p.product_id !== config.PRICE_PAIR ||
          !/^\d+(\.\d+)?$/.test(p.price) ||
          Number(p.price) <= 0 ||
          !p.trade_id
        )
          return;
        const at = new Date(p.time);
        if (
          !Number.isFinite(+at) ||
          +receipt - +at > 2000 ||
          +at - +receipt > 1000
        )
          return;
        void pool
          .query(
            "INSERT INTO price_observations(provider,pair,provider_at,received_at,price,sequence,payload) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
            [
              "coinbase",
              p.product_id,
              at,
              receipt,
              p.price,
              String(p.trade_id),
              {
                type: p.type,
                trade_id: p.trade_id,
                sequence: p.sequence,
                time: p.time,
                price: p.price,
                product_id: p.product_id,
              },
            ],
          )
          .catch(() => log("price_storage_failed"));
      } catch {
        log("price_payload_rejected");
      }
    });
    this.heartbeat = setInterval(() => {
      if (Date.now() - last > 15000) ws.terminate();
    }, 5000);
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      clearInterval(this.heartbeat);
      log("price_feed_disconnected");
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 3000);
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.socket?.close();
  }
}
