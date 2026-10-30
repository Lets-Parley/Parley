import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Every page that says "there is nothing here": a headline, one line of why,
 * and one way onward. `home={false}` is for a signed-link guest, who belongs
 * to one room and has no spaces to go back to; the sentence is their way on.
 */
export function DeadEnd({
  title,
  why,
  home = true,
  children,
}: {
  title: string;
  why: ReactNode;
  home?: boolean;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-3xl">{title}</h1>
      <p className="max-w-prose text-sm text-ink-soft text-pretty">{why}</p>
      {children}
      {home && (
        <Link to="/" className="inline-flex min-h-11 items-center font-bold text-accent underline underline-offset-4">
          Back to your spaces
        </Link>
      )}
    </main>
  );
}
