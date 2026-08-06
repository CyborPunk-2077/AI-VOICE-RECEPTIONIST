import * as React from "react";
import { AlertTriangle } from "lucide-react";

interface ErrorStateProps {
  title?: string;
  message: string;
}

export function ErrorState({ title = "Couldn't load this data", message }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-danger-soft text-danger">
        <AlertTriangle className="h-5 w-5" size={20} />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
