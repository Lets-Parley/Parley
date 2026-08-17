import { Avatar } from './components/Avatar'

export default function App() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-8 p-6 text-center">
      <h1 className="font-display text-6xl font-semibold">Parley</h1>
      <p className="max-w-md text-ink-soft">
        Planning poker and daily standups for your team, at your table.
        Self-hosted, no accounts, no fuss.
      </p>
      <div className="flex items-center gap-3 rounded-panel bg-surface p-6 shadow-rest">
        <Avatar name="Ada Lovelace" hue={210} facilitator />
        <Avatar name="Grace Hopper" hue={95} />
        <Avatar name="Mel" hue={330} spectator />
        <span className="ml-2 font-mono text-sm text-ink-soft">3 seated</span>
      </div>
      <p className="text-sm text-ink-faint">Spaces and sessions are on the way.</p>
    </main>
  )
}
