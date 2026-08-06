import { Topbar } from "@/components/layout/topbar";
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
import { CalendarCheck } from "lucide-react";
import { getAppointments, getServices } from "@/lib/queries";
import { bookingStatusVariant } from "@/lib/badge-variants";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AppointmentsPage() {
  const topbar = (
    <Topbar
      title="Appointments"
      description="Bookings made through the receptionist, tied to Google Calendar."
    />
  );

  let appointments, services;
  try {
    [appointments, services] = await Promise.all([getAppointments(), getServices()]);
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

  const upcoming = appointments.filter((a) => a.status === "Confirmed");
  const past = appointments
    .filter((a) => a.status !== "Confirmed")
    .sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

  return (
    <>
      {topbar}

      <div className="flex-1 space-y-6 p-6">
        {services.length === 0 ? (
          <Card>
            <EmptyState
              title="No services configured"
              description="Run the Supabase seed script to add the salon's bookable services."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {services.map((svc) => (
              <Card key={svc.id} className="p-5">
                <p className="text-sm font-medium">{svc.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{svc.duration_minutes} min</p>
              </Card>
            ))}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-foreground">Upcoming</CardTitle>
          </CardHeader>
          {upcoming.length === 0 ? (
            <EmptyState
              icon={CalendarCheck}
              title="No upcoming appointments"
              description="Confirmed bookings will show up here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcoming.map((appt) => (
                  <TableRow key={appt.id}>
                    <TableCell>
                      <div className="font-medium">{appt.customer_name}</div>
                      <div className="text-xs text-muted-foreground">{appt.customer_phone}</div>
                    </TableCell>
                    <TableCell>{appt.services?.name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(appt.start_time)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={bookingStatusVariant[appt.status]}>{appt.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-foreground">Past</CardTitle>
          </CardHeader>
          {past.length === 0 ? (
            <EmptyState
              icon={CalendarCheck}
              title="No past appointments"
              description="Completed and cancelled bookings will show up here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {past.map((appt) => (
                  <TableRow key={appt.id}>
                    <TableCell>
                      <div className="font-medium">{appt.customer_name}</div>
                      <div className="text-xs text-muted-foreground">{appt.customer_phone}</div>
                    </TableCell>
                    <TableCell>{appt.services?.name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(appt.start_time)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={bookingStatusVariant[appt.status]}>{appt.status}</Badge>
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
