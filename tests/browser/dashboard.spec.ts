import { test, expect } from "@playwright/test";
test("actual dashboard and subpath assets load on desktop and mobile", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/_next/"))
      failures.push(r.url());
  });
  await page.goto("/btcbet");
  await expect(
    page.getByRole("heading", { name: "Bitcoin Up or Down", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Place a bet with Keel" }),
  ).toBeVisible();
  await expect(
    page.getByText(/^(Mock payment mode|Signet Ark)$/, { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("price")).not.toHaveText("—", {
    timeout: 20000,
  });
  const before = await page.getByTestId("countdown").textContent();
  await expect
    .poll(() => page.getByTestId("countdown").textContent())
    .not.toBe(before);
  await page.getByRole("button", { name: "Market rules" }).click();
  await expect(page.getByText("01 · Take a side")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Bitcoin Up or Down", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  expect(failures).toEqual([]);
});
test("deterministic view follows pending, accepted, locked and settled states", async ({
  page,
}) => {
  let phase = "OPEN",
    status = "AWAITING_PAYMENT",
    price = "101.00";
  const start = new Date(
    Math.floor(Date.now() / 300000) * 300000,
  ).toISOString();
  const end = new Date(Date.now() + 60000).toISOString();
  const position = {
    id: "test",
    name: "Browser Atlas",
    direction: "UP",
    amount: "1000",
    status,
    created_at: start,
    accepted_at: null,
    final_payout: null,
  };
  await page.route("**/btcbet/api/v1/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "event: connected\ndata: {}\n\n",
    }),
  );
  await page.route("**/btcbet/api/v1/dashboard", (route) => {
    const paid = status === "PAID_OUT",
      accepted = status !== "AWAITING_PAYMENT";
    const r = {
      id: "1",
      start_at: start,
      end_at: end,
      lock_at: end,
      phase,
      opening: "100",
      closing: paid ? "102" : null,
      outcome: paid ? "UP" : null,
      upPool: accepted ? "1000" : "0",
      downPool: accepted ? "1000" : "0",
      totalPool: accepted ? "2000" : "0",
      upCount: accepted ? 1 : 0,
      downCount: accepted ? 1 : 0,
      upPercentage: 50,
      downPercentage: 50,
      positions: [
        {
          ...position,
          status,
          accepted_at: accepted ? start : null,
          final_payout: paid ? "2000" : null,
        },
      ],
      rules: { lockSeconds: 15, closeWindowSeconds: 5 },
    };
    return route.fulfill({
      json: {
        market: {
          adapter: "mock",
          round: r,
          currentPrice: price,
          observations: [
            { time: start, price: "100" },
            { time: new Date(+new Date(start) + 45000).toISOString(), price },
          ],
          rules: {},
        },
        history: paid ? [r] : [],
        leaderboard: [
          {
            id: "a",
            name: "Browser Atlas",
            bets: accepted ? 1 : 0,
            wins: paid ? 1 : 0,
            winRate: paid ? 1 : 0,
            netSats: paid ? "1000" : "0",
            streak: paid ? 1 : 0,
          },
        ],
        health: { wallet: { mode: "mock", ready: true }, priceAgeSeconds: 1 },
      },
    });
  });
  await page.goto("/btcbet");
  await expect(page.getByText("Browser Atlas").first()).toBeVisible();
  await expect(page.getByTestId("price-to-beat")).toHaveText("$100.00");
  await expect(page.getByTestId("chart-target")).toContainText("Target");
  await expect(page.getByTestId("live-chart")).toHaveAttribute(
    "data-range",
    "live",
  );
  await expect
    .poll(async () =>
      Number(await page.getByTestId("live-price-dot").getAttribute("cx")),
    )
    .toBeGreaterThan(750);
  await page.getByRole("button", { name: "Full round", exact: true }).click();
  await expect(page.getByTestId("live-chart")).toHaveAttribute(
    "data-range",
    "round",
  );
  await page.getByRole("button", { name: "Live · 60s", exact: true }).click();

  await expect(page.getByText("AWAITING PAYMENT").first()).toBeVisible();
  status = "ACCEPTED";
  price = "102.00";
  await expect(page.getByTestId("price")).toHaveText("$102.00", {
    timeout: 10000,
  });
  await expect(page.getByText("ACCEPTED").first()).toBeVisible();
  phase = "LOCKED";
  await expect(page.getByText("LOCKED", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  phase = "PAID";
  status = "PAID_OUT";
  await expect(page.getByText("PAID OUT").first()).toBeVisible({
    timeout: 10000,
  });
  await expect(
    page.locator("#history").getByText("$102.00", { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator("#leaderboard").getByText("100%", { exact: true }),
  ).toBeVisible();
});

test("refreshes chart observations every second when SSE is unavailable", async ({
  page,
}) => {
  const requestedAt: number[] = [];
  await page.route("**/btcbet/api/v1/events", (route) => route.abort());
  await page.route("**/btcbet/api/v1/dashboard", async (route) => {
    requestedAt.push(Date.now());
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.goto("/btcbet");
  await expect
    .poll(() => requestedAt.length, { timeout: 4500, intervals: [100] })
    .toBeGreaterThanOrEqual(4);
  const gaps = requestedAt.slice(1, 4).map((at, i) => at - requestedAt[i]);
  expect(Math.max(...gaps)).toBeLessThan(1800);
  await page.unrouteAll({ behavior: "wait" });
});
