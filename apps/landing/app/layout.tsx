import { GoogleTagManager } from "@next/third-parties/google";
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SmoothScroll } from "@/components/SmoothScroll";
import { openGraph, site } from "@/lib/site";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: site.title, template: "%s | VM Bridge" },
  description: site.description,
  applicationName: site.name,
  openGraph: { ...openGraph, title: site.title, description: site.description },
  twitter: { card: "summary_large_image" },
  icons: { icon: "/logo.svg", apple: "/apple-icon.png" },
};

export const viewport: Viewport = { themeColor: "#070708" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Flags JS availability before paint so `.reveal` blocks only hide when they can be revealed. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      {/* Production only, so local dev visits stay out of the analytics. */}
      {process.env.NODE_ENV === "production" && <GoogleTagManager gtmId="GTM-NLMD5J6R" />}
      <body>
        {children}
        <SmoothScroll />
      </body>
    </html>
  );
}
