import { Topbar } from "@/components/layout/topbar";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { salon, services, faqs, faqMisses } from "@/lib/mock-data";
import { formatDateTime } from "@/lib/format";

export default function SettingsPage() {
  const topFaqs = [...faqs].sort((a, b) => b.timesAsked - a.timesAsked);

  return (
    <>
      <Topbar
        title="Settings"
        description="Salon details, bookable services, and the approved FAQ list. Read-only in this preview."
      />

      <div className="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-foreground">
              Salon details
            </CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2">
            <Field label="Name" value={salon.name} />
            <Field label="Phone" value={salon.phone} />
            <Field label="Address" value={salon.address} />
            <Field label="Hours" value={salon.hours} />
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-foreground">
              Bookable services
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Exactly three services are supported — this list is fixed by design.
            </p>
          </CardHeader>
          <div className="divide-y divide-border">
            {services.map((svc) => (
              <div key={svc.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-medium">{svc.name}</p>
                  <p className="text-xs text-muted-foreground">{svc.description}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium">${svc.price}</p>
                  <p className="text-xs text-muted-foreground">{svc.durationMinutes} min</p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-foreground">
              Approved FAQs
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              The receptionist only answers from this list — anything else gets transferred.
            </p>
          </CardHeader>
          <div className="divide-y divide-border">
            {topFaqs.map((faq) => (
              <div key={faq.id} className="flex items-start justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{faq.question}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{faq.answer}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {faq.timesAsked}&times; asked
                  </span>
                  <Badge variant={faq.active ? "success" : "neutral"}>
                    {faq.active ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold text-foreground">
              Unanswered questions
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Questions outside the approved FAQ list — candidates for expanding coverage.
            </p>
          </CardHeader>
          <div className="divide-y divide-border">
            {faqMisses.map((miss) => (
              <div key={miss.id} className="flex items-center justify-between px-5 py-3">
                <p className="text-sm">{miss.question}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(miss.askedAt)}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm">{value}</p>
      <Separator className="mt-3 sm:hidden" />
    </div>
  );
}
