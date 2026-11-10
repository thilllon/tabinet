import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  description: string;
  /** A control for the whole section (e.g. "Change in Chrome"), shown in the heading, at the right. */
  action?: ReactNode;
  children: ReactNode;
}

/** One boxed section of the Settings dialog, with a heading and an explanation. */
export function SettingsSection({ title, description, action, children }: SettingsSectionProps) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-3">
        <div className="min-w-48 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      <div className="space-y-5 px-4 py-4">{children}</div>
    </section>
  );
}
