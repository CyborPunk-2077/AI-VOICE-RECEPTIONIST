import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PhoneCall } from "lucide-react";
import { getCalls } from "@/lib/queries";
import { outcomeVariant, intentVariant } from "@/lib/badge-variants";
import { formatDateTime, formatDuration } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CallsPage() {
  let calls;
  try {
    calls = await getCalls();
  } catch (err) {
    return (
      <>
        <Topbar
          title="Calls"
          description="Every call the receptionist answers is recorded here."
        />
        <div className="flex-1 p-6">
          <Card>
            <ErrorState
              message={
                err instanceof Error
                  ? err.message
                  : "Unknown error connecting to Supabase."
              }
            />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Calls"
        description={`${calls.length} call${calls.length === 1 ? "" : "s"} logged — every call the receptionist answers is recorded here.`}
      />

      <div className="flex-1 p-6">
        <Card>
          {calls.length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="No calls yet"
              description="Once the receptionist starts taking calls, they'll be logged here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Caller</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Intent</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((call) => (
                  <TableRow key={call.id}>
                    <TableCell>
                      <div className="font-medium">{call.caller_name ?? "Unknown Caller"}</div>
                      <div className="text-xs text-muted-foreground">{call.caller_number}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(call.started_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {call.duration_seconds != null ? formatDuration(call.duration_seconds) : "—"}
                    </TableCell>
                    <TableCell>
                      {call.intent ? (
                        <Badge variant={intentVariant[call.intent]}>{call.intent}</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {call.outcome ? (
                        <Badge variant={outcomeVariant[call.outcome]}>{call.outcome}</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-sm text-muted-foreground">
                      {call.summary ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
