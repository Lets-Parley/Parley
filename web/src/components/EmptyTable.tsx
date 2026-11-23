import type { ReactNode } from "react";

/** Felt, a couple of cards, and one thing to do. */
export function EmptyTable({
  heading,
  body,
  actions,
  footnote,
  art,
}: {
  heading: string;
  body: string;
  actions?: ReactNode;
  footnote?: string;
  /** Defaults to the card stack. A session without a deck brings its own. */
  art?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 px-8 py-16">
      {art ?? (
      <div className="relative h-24 w-[120px]">
        <span className="absolute inset-x-2.5 bottom-0 top-6 rounded-[10px] border border-line bg-felt-deep shadow-well" />
        <span className="absolute left-8 top-0.5 h-[54px] w-[38px] -rotate-[7deg] rounded-chip border border-line bg-surface shadow-rest" />
        <span className="absolute left-[52px] top-1.5 flex h-[54px] w-[38px] rotate-[6deg] items-center justify-center rounded-chip bg-card-back shadow-rest">
          <span className="h-2.5 w-2.5 rotate-45 border-2 border-pip opacity-50" />
        </span>
        <span className="absolute inset-x-1 bottom-0 top-11 rounded-[10px] border border-line bg-felt-deep" />
      </div>
      )}
      <p className="font-display text-[1.75rem]">{heading}</p>
      <p className="max-w-[420px] text-center text-sm text-ink-soft text-pretty">{body}</p>
      {actions && <div className="flex flex-wrap items-center justify-center gap-2.5">{actions}</div>}
      {footnote && (
        <p className="max-w-[400px] text-center text-xs text-ink-faint text-pretty">{footnote}</p>
      )}
    </div>
  );
}
