import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'

export const metadata: Metadata = {
  title: 'Throxy Persona Ranker',
  description: 'Rank leads by fit to your ideal profile.',
}

const themeScript = `(function(){var t=localStorage.getItem('lros-theme');var d=!(t==='light'||(t==='dark'));if(d){var m=window.matchMedia('(prefers-color-scheme: dark)');t=m&&m.matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);})();`

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  )
}
