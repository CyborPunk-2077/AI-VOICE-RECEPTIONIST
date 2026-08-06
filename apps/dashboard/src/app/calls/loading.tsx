import { Topbar } from "@/components/layout/topbar";
import { Card } from "@/components/ui/card";
import { LoadingTable } from "@/components/ui/loading-table";

export default function CallsLoading() {
  return (
    <>
      <Topbar
        title="Calls"
        description="Every call the receptionist answers is recorded here."
      />
      <div className="flex-1 p-6">
        <Card>
          <LoadingTable rows={8} />
        </Card>
      </div>
    </>
  );
}
