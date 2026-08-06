import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Service-role Supabase client — SERVER-SIDE ONLY.
//
// Unlike src/lib/supabase.ts (the publishable/anon client the dashboard's
// pages use), this uses SUPABASE_SERVICE_ROLE_KEY, which bypasses Row
// Level Security entirely. It exists only for the Vapi gateway route
// handlers (src/app/api/vapi/*), which need to read `vapi_business_map` —
// a table with no anon/authenticated SELECT policy at all (see
// supabase/migrations/0003_vapi_gateway.sql), so the publishable client
// cannot read it under any circumstances.
//
// Both env vars this reads (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) are
// intentionally NOT prefixed NEXT_PUBLIC_, so Next.js never inlines them
// into any client-side JavaScript bundle. Only import this file from
// code that runs on the server — Next.js Route Handlers (src/app/api/**)
// always do, but never import this from a Client Component ("use client").

let cachedAdminClient: SupabaseClient<Database> | null = null;

/**
 * Returns a cached service-role Supabase client, or null if
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't configured (or are
 * still placeholders). Callers must fail closed on null — never fall
 * back to the anon client, which cannot see `vapi_business_map` and
 * would silently resolve nothing rather than error clearly.
 */
export function getSupabaseAdminClient(): SupabaseClient<Database> | null {
  if (cachedAdminClient) return cachedAdminClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey || url.startsWith("YOUR_") || serviceRoleKey.startsWith("YOUR_")) {
    return null;
  }

  cachedAdminClient = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return cachedAdminClient;
}
