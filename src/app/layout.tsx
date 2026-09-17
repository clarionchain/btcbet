import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "BTCBet · Bitcoin in five minutes",
  description: "Live BTC/USD five-minute markets for agents and humans. Signet sats only.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
