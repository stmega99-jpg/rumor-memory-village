import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rumor Memory Village",
  description:
    "A long-lived memory layer for multi-agent worlds, demonstrated through a village rumor.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
