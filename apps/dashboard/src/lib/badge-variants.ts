import type { BookingStatus } from "@/lib/mock-data";
import type { CallIntent, CallOutcome } from "@/lib/database.types";
import type { BadgeProps } from "@/components/ui/badge";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export const outcomeVariant: Record<CallOutcome, BadgeVariant> = {
  "FAQ Answered": "accent",
  Booked: "success",
  Transferred: "warning",
  "No Match": "danger",
  "Info Provided": "accent",
  "Callback Requested": "warning",
};

export const intentVariant: Record<CallIntent, BadgeVariant> = {
  FAQ: "neutral",
  Booking: "accent",
  Transfer: "warning",
  Info: "neutral",
  Callback: "accent",
};

export const bookingStatusVariant: Record<BookingStatus, BadgeVariant> = {
  Confirmed: "accent",
  Completed: "success",
  Cancelled: "danger",
};
