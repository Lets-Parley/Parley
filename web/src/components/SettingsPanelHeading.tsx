export function SettingsPanelHeading({
  title,
  description,
  danger = false,
}: {
  title: string;
  description: string;
  danger?: boolean;
}) {
  return (
    <>
      <h2 className={`text-base font-bold ${danger ? "text-stop" : "text-ink"}`}>{title}</h2>
      <p className="mt-1 text-[13px] text-ink-soft text-pretty">{description}</p>
    </>
  );
}
