import { getSupabaseClient } from "@/lib/supabase";
import type { Appointment, Call, Service } from "@/lib/database.types";

export type AppointmentWithService = Appointment & { services: Service | null };

export async function getCalls(): Promise<Call[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .order("started_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function getAppointments(): Promise<AppointmentWithService[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("appointments")
    .select("*, services(*)")
    .order("start_time", { ascending: true });

  if (error) throw error;
  // No cast needed: the appointments→services foreign key is declared in
  // database.types.ts, so supabase-js infers the embedded shape itself.
  return data ?? [];
}

export async function getServices(): Promise<Service[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("services")
    .select("*")
    .eq("active", true)
    .order("duration_minutes", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export function getTodayStats(calls: Call[], appointments: AppointmentWithService[]) {
  return {
    callsToday: calls.length,
    bookingsToday: calls.filter((c) => c.outcome === "Booked").length,
    humanTransfers: calls.filter((c) => c.outcome === "Transferred").length,
    missedCalls: calls.filter((c) => c.outcome === "No Match").length,
    upcomingAppointments: appointments.filter((a) => a.status === "Confirmed").length,
  };
}
