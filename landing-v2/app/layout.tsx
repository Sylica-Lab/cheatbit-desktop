import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Sylica AI - Your Private Interview Copilot',
  description: 'Invisible AI assistant for technical interviews. Real-time solutions, debugging, and system audio analysis. Stay ahead without detection.',
  keywords: 'AI interview assistant, coding interview help, technical interview prep, AI copilot, stealth AI',
  openGraph: {
    title: 'Sylica AI - Your Private Interview Copilot',
    description: 'The invisible AI assistant that helps you ace technical interviews in real-time.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
