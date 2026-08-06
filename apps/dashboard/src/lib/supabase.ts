import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Read-only client for the dashboard (Overview, Calls, Appointments pages).
// Uses the publishable (anon) key only — RLS on every table allows SELECT
// and denies writes for this key, so this is safe to use in server
// components. Never import the service-role key here.

let cachedClient: SupabaseClient<Database> | null = null;

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

export function getSupabaseClient(): SupabaseClient<Database> {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey || url.startsWith("YOUR_") || publishableKey.startsWith("YOUR_")) {
    throw new SupabaseConfigError(
      "Supabase is not configured yet. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in apps/dashboard/.env.local — see docs/database.md."
    );
  }

  cachedClient = createClient<Database>(url, publishableKey, {
    auth: { persistSession: false },
  });
  return cachedClient;
}
