import { type ReactNode, useEffect, useRef } from "react";

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(92vw,26rem)] rounded-panel bg-surface p-6 text-ink shadow-lift backdrop:bg-card-back/40 backdrop:backdrop-blur-sm"
    >
      <h2 className="font-display mb-4 text-2xl font-semibold">{title}</h2>
      {children}
    </dialog>
  );
}

export const buttonPrimary =
  "rounded-chip bg-accent px-4 py-2 font-bold text-accent-ink transition hover:brightness-110 disabled:opacity-50";
export const buttonQuiet =
  "rounded-chip border border-line px-4 py-2 font-bold text-ink-soft transition hover:bg-felt-deep";
export const buttonDanger =
  "rounded-chip bg-stop px-4 py-2 font-bold text-accent-ink transition hover:brightness-110";
export const inputClass =
  "w-full rounded-chip border border-line bg-surface-hi px-3 py-2 text-ink outline-none focus:border-accent";
