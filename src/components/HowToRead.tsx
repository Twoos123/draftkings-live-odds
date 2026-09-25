const ITEMS: [string, string][] = [
  ["Moneyline", "Pick the winner. −150 means you risk $150 to win $100 (the favorite); +130 means a $100 bet wins $130 (the underdog)."],
  [
    "Spread",
    "The favorite (−3.5) has to win by 4 or more; the underdog (+3.5) covers if it loses by 3 or fewer, or wins. The small number underneath is the price, usually around −110.",
  ],
  ["Total", "Bet on the two teams' combined score finishing Over (O) or Under (U) the number."],
  ["Decimal", "What comes back per $1 staked, stake included: 2.50 returns $2.50."],
  [
    "Full game / 1st half",
    "Switch every line on the page between the whole game and its 1st half, which is settled on the score at halftime. DraftKings posts 1st-half lines a few days before kickoff and takes them down during the game.",
  ],
  ["▲ ▼ and crossed-out numbers", "The line just moved. Green went up, red went down; the old number stays crossed out for 10 minutes."],
  ["Lock icon", "DraftKings has paused betting on that market, usually around breaking news or kickoff."],
  ["Hover a price", "See the implied chance of winning that the price represents."],
];

export function HowToRead() {
  return (
    <details className="group mt-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <summary className="flex cursor-pointer select-none list-none items-center justify-between font-medium [&::-webkit-details-marker]:hidden">
        How to read these odds
        <svg className="h-4 w-4 text-muted transition-transform group-open:rotate-180" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
        {ITEMS.map(([term, text]) => (
          <div key={term} className="contents">
            <dt className="font-medium">{term}</dt>
            <dd className="text-muted">{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
