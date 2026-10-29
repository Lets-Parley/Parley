import { useEffect } from "react";
import { Link } from "react-router-dom";

/** The catch-all route, and what a dead /s/{slug} link lands on. */
export function NotFoundPage() {
  useEffect(() => {
    const previous = document.title;
    document.title = "Page not found";
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-3xl">Page not found</h1>
      <p className="max-w-prose text-sm text-ink-soft">
        Check the address or return to your spaces.
      </p>
      <Link to="/" className="inline-flex min-h-11 items-center font-bold text-accent underline underline-offset-4">
        Back to your spaces
      </Link>
    </main>
  );
}
