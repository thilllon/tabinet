import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  /** A small logo shown left of the title (e.g. the YouTube logo). */
  icon?: ReactNode;
  description: string;
  /** A control for the whole section (e.g. "Change in Chrome"), shown in the heading, at the right. */
  action?: ReactNode;
  children: ReactNode;
}

/** One boxed section of the Settings dialog, with a heading and an explanation. */
export function SettingsSection({
  title,
  icon,
  description,
  action,
  children,
}: SettingsSectionProps) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-3">
        <div className="min-w-48 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      <div className="space-y-5 px-4 py-4">{children}</div>
    </section>
  );
}
