import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'project-forge',
  description: 'AI-native software development platform',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} bg-zinc-950 text-zinc-100 min-h-screen`}>
        <nav className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4">
          <a href="/projects" className="text-sm font-semibold text-zinc-100 hover:text-white">
            ⚒️ project-forge
          </a>
          <div className="flex-1" />
          <a
            href="/projects/new"
            className="text-sm bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md transition-colors"
          >
            + New Project
          </a>
        </nav>
        <main className="px-6 py-8 max-w-6xl mx-auto">
          {children}
        </main>
      </body>
    </html>
  )
}
