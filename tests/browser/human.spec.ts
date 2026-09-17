import { expect, test } from "@playwright/test";

test("human creates a persistent player and Keel QR wager", async ({ page }) => {
  const returnAddress = process.env.BTCBET_HUMAN_TEST_ADDRESS;
  test.skip(!returnAddress, "Set an isolated-test Keel return address");
  await page.goto("/btcbet");
  await page.getByLabel("Display name").fill(`Browser Human ${Date.now()}`);
  await page
    .getByLabel("Keel payout and refund address")
    .fill(returnAddress!);
  await page.getByRole("button", { name: "Create player" }).click();
  await expect(page.getByText("Save your recovery code")).toBeVisible();
  await page.getByRole("button", { name: "I saved it" }).click();
  await page.getByRole("button", { name: "↘ DOWN" }).click();
  await page.getByRole("button", { name: "1,000 sats" }).click();
  await page.getByRole("button", { name: "Create DOWN payment" }).click();
  await expect(
    page.getByAltText("Keel Ark payment address QR code"),
  ).toBeVisible();
  await expect(page.getByText("Waiting for payment confirmation")).toBeVisible();
  const src = await page
    .getByAltText("Keel Ark payment address QR code")
    .getAttribute("src");
  expect(src).toMatch(/\/humans\/bets\/[0-9a-f-]+\/qr$/);
  await page.reload();
  await expect(page.getByText(/Human · Browser Human/)).toBeVisible();
  await expect(
    page.getByAltText("Keel Ark payment address QR code"),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/human-payment.png",
    fullPage: true,
  });
});
