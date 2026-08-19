import type { Metadata } from "next";
import "./globals.css";
import { TelemetryBoot } from "@/components/TelemetryBoot";

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
      <body className="min-h-screen">
        {/* Renders nothing — installs global error capture and uploads
            crash reports the desktop shell spooled to disk. Mounted at
            the root so it covers every screen, including the auth pages
            where a failure means the user can't get in at all. */}
        <TelemetryBoot />
        {children}
      </body>
    </html>
  );
}
