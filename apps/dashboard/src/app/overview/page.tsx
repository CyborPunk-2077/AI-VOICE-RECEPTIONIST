import { Topbar } from "@/components/layout/topbar";
import { StatCard } from "@/components/ui/stat-card";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
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
import { PhoneCall, CalendarCheck, Users, PhoneMissed } from "lucide-react";
import { getAppointments, getCalls, getTodayStats } from "@/lib/queries";
import { outcomeVariant } from "@/lib/badge-variants";
import { formatDateTime, formatDuration } from "@/lib/format";
import { BUSINESS_NAME } from "@/lib/branding";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OverviewPage() {
  const topbar = (
    <Topbar
      title="Overview"
      description={`Today at ${BUSINESS_NAME} — calls, bookings, and what needs attention.`}
    />
  );

  let calls, appointments;
  try {
    [calls, appointments] = await Promise.all([getCalls(), getAppointments()]);
  } catch (err) {
    return (
      <>
        {topbar}
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

  const stats = getTodayStats(calls, appointments);
  const recentCalls = calls.slice(0, 6);
  const upcoming = appointments.filter((a) => a.status === "Confirmed").slice(0, 5);

  return (
    <>
      {topbar}

      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Calls Today" value={stats.callsToday} icon={PhoneCall} tone="accent" />
          <StatCard
            label="Bookings Today"
            value={stats.bookingsToday}
            icon={CalendarCheck}
            tone="success"
          />
          <StatCard
            label="Human Transfers"
            value={stats.humanTransfers}
            icon={Users}
            tone="warning"
          />
          <StatCard
            label="Missed Calls"
            value={stats.missedCalls}
            icon={PhoneMissed}
            tone="danger"
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
          <Card className="xl:col-span-3">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base font-semibold text-foreground">
                Recent calls
              </CardTitle>
              <Link href="/calls" className="text-sm font-medium text-accent hover:underline">
                View all
              </Link>
            </CardHeader>
            {recentCalls.length === 0 ? (
              <EmptyState
                icon={PhoneCall}
                title="No calls yet"
                description="Calls logged by the receptionist will show up here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Caller</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentCalls.map((call) => (
                    <TableRow key={call.id}>
                      <TableCell>
                        <div className="font-medium">{call.caller_name ?? "Unknown Caller"}</div>
                        <div className="text-xs text-muted-foreground">{call.caller_number}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(call.started_at)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {call.duration_seconds != null ? formatDuration(call.duration_seconds) : "—"}
                      </TableCell>
                      <TableCell>
                        {call.outcome ? (
                          <Badge variant={outcomeVariant[call.outcome]}>{call.outcome}</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card className="xl:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base font-semibold text-foreground">
                Upcoming appointments
              </CardTitle>
              <Link
                href="/appointments"
                className="text-sm font-medium text-accent hover:underline"
              >
                View all
              </Link>
            </CardHeader>
            {upcoming.length === 0 ? (
              <EmptyState
                icon={CalendarCheck}
                title="No upcoming appointments"
                description="Confirmed bookings will show up here."
              />
            ) : (
              <div className="divide-y divide-border">
                {upcoming.map((appt) => (
                  <div key={appt.id} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-sm font-medium">{appt.customer_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {appt.services?.name ?? "Service"} · {formatDateTime(appt.start_time)}
                      </p>
                    </div>
                    <Badge variant="accent">{appt.services?.name ?? "Service"}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
