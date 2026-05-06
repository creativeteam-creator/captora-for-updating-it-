import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Captora — Auto Captions",
  description: "Captora — viral-style captions for video and audio uploads.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
