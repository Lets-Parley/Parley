import type { DescribedGrant } from "../lib/plugins";

/**
 * One capability, as a consequence. Grant descriptions come from the server.
 */
export function GrantList({ grants, tone }: { grants: DescribedGrant[]; tone?: "add" | "drop" }) {
  if (grants.length === 0) return null;
  return (
    <ul className="mt-2 space-y-2">
      {grants.map((g) => (
        <li
          key={`${g.capability}:${g.scope}`}
          className={
            "rounded-chip border px-3 py-2 text-[13px] text-pretty " +
            (tone === "add"
              ? "border-stop"
              : tone === "drop"
                ? "border-line text-ink-faint"
                : "border-line")
          }
        >
          <p>{g.limits ? <strong>{g.permits}</strong> : g.permits}</p>
          {g.limits && <p className="mt-1 text-ink-soft">Limits: {g.limits}</p>}
          {g.allows && g.allows.length > 0 && (
            <p className="mt-1 text-ink-soft">
              For example: {g.allows.join(", ")}
              {g.refuses && g.refuses.length > 0 && <> — but not {g.refuses.join(", ")}.</>}
            </p>
          )}
          <p className="mt-1 font-mono text-[11px] text-ink-faint">
            {g.capability}
            {g.scope ? `: ${g.scope}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
