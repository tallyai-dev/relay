// Relay brand mark — the "Bolt Bubble": a speech bubble carrying a lightning
// bolt. Conversations, fast. Green (#12b76a) with a white bolt.
export function BoltMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" aria-label="Relay">
      <rect x="10" y="14" width="76" height="58" rx="18" fill="#12b76a" />
      <path d="M30 70 L24 88 L46 71 Z" fill="#12b76a" />
      <path d="M54 24 L38 50 L50 50 L43 64 L62 40 L50 40 Z" fill="#ffffff" />
    </svg>
  );
}
