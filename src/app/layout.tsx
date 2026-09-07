import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Lotline',
  description: 'Lot-based quality assurance and compliance for Australian civil works',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
