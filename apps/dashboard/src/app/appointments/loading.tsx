import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import { LoadingTable } from "@/components/ui/loading-table";

export default function AppointmentsLoading() {
  return (
    <>
      <Topbar
        title="Appointments"
        description="Bookings made through the receptionist, tied to Google Calendar."
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="h-16 animate-pulse p-5" />
          ))}
        </div>
        <Card>
          <LoadingTable rows={4} />
        </Card>
        <Card>
          <LoadingTable rows={4} />
        </Card>
      </div>
    </>
  );
}
