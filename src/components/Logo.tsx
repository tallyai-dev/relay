// Relay brand mark — the "Bolt Bubble": a speech bubble carrying a lightning
// bolt. Conversations, fast. App blue (#2563eb) with a white bolt, matching
// the accent used across the UI.
// `tight` crops the artboard padding so the bubble fills the box — use it where
// the mark needs presence at small sizes (the rail logo).
export function BoltMark({ size = 34, tight = false }: { size?: number; tight?: boolean }) {
  return (
    <svg width={size} height={size} viewBox={tight ? '8 12 80 78' : '0 0 96 96'} fill="none" aria-label="Relay">
      <rect x="10" y="14" width="76" height="58" rx="18" fill="#2563eb" />
      <path d="M30 70 L24 88 L46 71 Z" fill="#2563eb" />
      <path d="M54 24 L38 50 L50 50 L43 64 L62 40 L50 40 Z" fill="#ffffff" />
    </svg>
  );
}
