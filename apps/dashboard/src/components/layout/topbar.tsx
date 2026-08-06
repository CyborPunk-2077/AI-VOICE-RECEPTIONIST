import * as React from "react";

interface TopbarProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function Topbar({ title, description, action }: TopbarProps) {
  return (
    <div className="flex flex-col gap-4 border-b border-border bg-card px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
