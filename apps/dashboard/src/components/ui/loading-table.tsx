import * as React from "react";

export function LoadingTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="animate-pulse divide-y divide-border">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="h-3 w-32 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="ml-auto h-5 w-20 rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}
