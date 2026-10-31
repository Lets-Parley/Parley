import { NavLink } from "react-router-dom";
import { TOUCH_HIT } from "../lib/breakpoints";
import { adminPath, pluginsPath } from "../lib/paths";

const tab = ({ isActive }: { isActive: boolean }) =>
  `${TOUCH_HIT} inline-flex items-center border-b-2 px-1 text-sm font-bold ${
    isActive ? "border-accent text-ink" : "border-transparent text-ink-soft hover:text-ink"
  }`;

/** The org admin hub's tabs. Plugins keeps its own page and URL. */
export function AdminTabs({ org }: { org: string }) {
  return (
    <nav aria-label="Org admin" className="mt-6 flex flex-wrap gap-x-6 border-b border-line">
      <NavLink to={adminPath(org, "spaces")} className={tab}>Spaces</NavLink>
      <NavLink to={adminPath(org, "members")} className={tab}>Members</NavLink>
      <NavLink to={pluginsPath(org)} className={tab}>Plugins</NavLink>
      <NavLink to={adminPath(org, "audit")} className={tab}>Audit log</NavLink>
    </nav>
  );
}
