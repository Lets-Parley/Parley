import type { useNotificationSoundControls } from "../lib/useNotificationSoundControls";
import { menuItem } from "./ActionMenu";
import { buttonQuiet } from "./Modal";

export function NotificationSoundButton({
  controls: { enabled, saving, toggle, recover },
  blocked,
  inMenu = false,
}: {
  controls: ReturnType<typeof useNotificationSoundControls>;
  blocked: boolean;
  inMenu?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        className={inMenu ? menuItem : buttonQuiet + " shrink-0 px-3 py-1.5 text-[12px]"}
        aria-label={enabled ? "Mute notification sounds" : "Unmute notification sounds"}
        aria-pressed={enabled}
        aria-disabled={saving || undefined}
        onClick={() => void toggle()}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="hidden h-4 w-4 md:max-lg:block" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
          {enabled ? <path d="M11 5.5a3.5 3.5 0 0 1 0 5" /> : <path d="m11 6 3 4m0-4-3 4" />}
        </svg>
        <span className="md:max-lg:hidden">{enabled ? "Sounds on" : "Sounds off"}</span>
      </button>
      {enabled && blocked && (
        <button type="button" className={inMenu ? menuItem : buttonQuiet} onClick={() => void recover()}>
          Enable audio in this tab
        </button>
      )}
    </>
  );
}
