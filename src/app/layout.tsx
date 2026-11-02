import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { ImportWatcher } from "../../customize-tool/components/char/import-status";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlexiPrint",
  description: "FlexiPrint — personalized product builder for Shopify",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased min-h-screen">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
          <ImportWatcher />
        </ThemeProvider>
      </body>
    </html>
  );
}
