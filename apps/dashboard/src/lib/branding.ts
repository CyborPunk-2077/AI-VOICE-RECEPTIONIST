// Who this dashboard is for.
//
// "Lumen Salon" used to be hardcoded in five files. It is the name in
// supabase/seed.sql, so it was right for the seeded demo and wrong for every
// real client — and onboarding a business is supposed to be a config change,
// not a find-and-replace.
//
// NEXT_PUBLIC_ is correct here: the sidebar and page headers are client
// components, this is a display name rather than a secret, and it must be
// inlined at build time. Read it through these helpers, never
// process.env directly — Next.js only inlines literal
// `process.env.NEXT_PUBLIC_FOO` references, so a dynamic lookup silently
// yields undefined in the browser.
//
// This is single-business by design, matching what the dashboard's queries
// assume. The agent core is multi-business; the dashboard is not yet. See
// docs/todo.md.

export const BUSINESS_NAME = process.env.NEXT_PUBLIC_BUSINESS_NAME || "Lumen Salon";

/** Sidebar avatar monogram: "Sharma Dental" → "SD". */
export const BUSINESS_INITIALS =
  BUSINESS_NAME.split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "RF";
