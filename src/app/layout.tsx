import type { Metadata } from "next";
import Script from "next/script";

import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/poppins/devanagari-400.css";
import "@fontsource/poppins/devanagari-500.css";
import "@fontsource/poppins/devanagari-600.css";
import "@fontsource/poppins/devanagari-700.css";
import "@fontsource/poppins/devanagari-800.css";
import "@fontsource/poppins/devanagari-900.css";
import "@fontsource/poppins/latin-400.css";
import "@fontsource/poppins/latin-500.css";
import "@fontsource/poppins/latin-600.css";
import "@fontsource/poppins/latin-700.css";
import "@fontsource/poppins/latin-800.css";
import "@fontsource/poppins/latin-900.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Samrat Group | Case Review",
  description:
    "Secure document intake, comparison, and mismatch review for Samrat Group cases.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <Script src="/api/runtime-config" strategy="beforeInteractive" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
