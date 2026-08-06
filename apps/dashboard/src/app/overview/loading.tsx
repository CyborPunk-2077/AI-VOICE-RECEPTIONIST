import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import { LoadingTable } from "@/components/ui/loading-table";
import { BUSINESS_NAME } from "@/lib/branding";

export default function OverviewLoading() {
  return (
    <>
      <Topbar
        title="Overview"
        description={`Today at ${BUSINESS_NAME} — calls, bookings, and what needs attention.`}
      />
      <div className="flex-1 space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="h-24 animate-pulse p-5" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
          <Card className="xl:col-span-3">
            <LoadingTable rows={6} />
          </Card>
          <Card className="xl:col-span-2">
            <LoadingTable rows={5} />
          </Card>
        </div>
      </div>
    </>
  );
}
