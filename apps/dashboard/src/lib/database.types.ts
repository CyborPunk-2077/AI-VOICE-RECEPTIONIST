// Hand-written to match supabase/migrations/0001_init.sql,
// 0002_multi_business.sql, and 0003_vapi_gateway.sql. Regenerate with
// `supabase gen types typescript` once the Supabase CLI is wired up; until
// then, keep this in sync with the migrations by hand.
//
// `Relationships` is not decoration. supabase-js resolves embedded selects
// like `.select("*, services(*)")` through it at the type level, and an
// empty array means "this table joins to nothing" — which made
// queries.ts's appointments query fail to typecheck even though the foreign
// key exists in 0001_init.sql and PostgREST resolves it fine at runtime.
// If you add a `references` to a migration, add it here too.

// The 0002 migration widens the `calls` CHECK constraints to a superset of
// the original values, so both the Phase-1 salon vocabulary and the
// template's more general vocabulary are valid rows.
export type CallIntent = "FAQ" | "Booking" | "Transfer" | "Info" | "Callback";
export type CallOutcome =
  | "FAQ Answered"
  | "Booked"
  | "Transferred"
  | "No Match"
  | "Info Provided"
  | "Callback Requested";
export type AppointmentStatus = "Confirmed" | "Completed" | "Cancelled";
export type PriceDisclosure = "exact" | "range" | "not_disclosed";
export type NotifyChannel = "sms" | "whatsapp" | "none";
export type AvailabilitySource = "google_calendar" | "staff_roster" | "not_tracked";
export type CallbackStatus = "Pending" | "Contacted" | "Closed";

export interface Database {
  public: {
    Tables: {
      businesses: {
        Row: {
          id: string;
          name: string;
          address: string;
          phone: string;
          timezone: string;
          hours_text: string;
          business_slug: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          address: string;
          phone: string;
          timezone?: string;
          hours_text: string;
          business_slug: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["businesses"]["Insert"]>;
        Relationships: [];
      };
      services: {
        Row: {
          id: string;
          business_id: string;
          name: string;
          duration_minutes: number;
          description: string | null;
          active: boolean;
          price_disclosure: PriceDisclosure;
          price_amount: number | null;
          price_range: string | null;
          bookable: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          name: string;
          duration_minutes: number;
          description?: string | null;
          active?: boolean;
          price_disclosure?: PriceDisclosure;
          price_amount?: number | null;
          price_range?: string | null;
          bookable?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["services"]["Insert"]>;
        Relationships: [];
      };
      business_settings: {
        Row: {
          business_id: string;
          industry: string | null;
          languages_supported: string[];
          default_language: string;
          currency: string;
          directions_note: string | null;
          opening_hours: Record<string, unknown>;
          price_policy: Record<string, unknown>;
          booking_enabled: boolean;
          confirmation_channel: NotifyChannel;
          callback_number: string | null;
          callback_notify_channel: NotifyChannel;
          transfer_number: string | null;
          restricted_topics: string[];
          availability_source: AvailabilitySource;
          calendar_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          business_id: string;
          industry?: string | null;
          languages_supported?: string[];
          default_language?: string;
          currency?: string;
          directions_note?: string | null;
          opening_hours?: Record<string, unknown>;
          price_policy?: Record<string, unknown>;
          booking_enabled?: boolean;
          confirmation_channel?: NotifyChannel;
          callback_number?: string | null;
          callback_notify_channel?: NotifyChannel;
          transfer_number?: string | null;
          restricted_topics?: string[];
          availability_source?: AvailabilitySource;
          calendar_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["business_settings"]["Insert"]>;
        Relationships: [];
      };
      faqs: {
        Row: {
          id: string;
          business_id: string;
          question: string;
          answer: string;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          question: string;
          answer: string;
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["faqs"]["Insert"]>;
        Relationships: [];
      };
      staff: {
        Row: {
          id: string;
          business_id: string;
          name: string;
          role: string | null;
          services: string[];
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          name: string;
          role?: string | null;
          services?: string[];
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["staff"]["Insert"]>;
        Relationships: [];
      };
      staff_availability: {
        Row: {
          id: string;
          business_id: string;
          staff_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          staff_id: string;
          weekday: number;
          start_time: string;
          end_time: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["staff_availability"]["Insert"]>;
        Relationships: [];
      };
      callback_requests: {
        Row: {
          id: string;
          business_id: string;
          call_id: string | null;
          customer_name: string;
          customer_phone: string;
          reason: string;
          preferred_callback_time: string | null;
          status: CallbackStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          call_id?: string | null;
          customer_name: string;
          customer_phone: string;
          reason: string;
          preferred_callback_time?: string | null;
          status?: CallbackStatus;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["callback_requests"]["Insert"]>;
        Relationships: [];
      };
      calls: {
        Row: {
          id: string;
          business_id: string;
          caller_name: string | null;
          caller_number: string;
          started_at: string;
          ended_at: string | null;
          duration_seconds: number | null;
          intent: CallIntent | null;
          outcome: CallOutcome | null;
          summary: string | null;
          transfer_reason: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          caller_name?: string | null;
          caller_number: string;
          started_at?: string;
          ended_at?: string | null;
          duration_seconds?: number | null;
          intent?: CallIntent | null;
          outcome?: CallOutcome | null;
          summary?: string | null;
          transfer_reason?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["calls"]["Insert"]>;
        Relationships: [];
      };
      appointments: {
        Row: {
          id: string;
          business_id: string;
          service_id: string;
          call_id: string | null;
          customer_name: string;
          customer_phone: string;
          start_time: string;
          end_time: string;
          status: AppointmentStatus;
          calendar_event_id: string | null;
          staff_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          service_id: string;
          call_id?: string | null;
          customer_name: string;
          customer_phone: string;
          start_time: string;
          end_time: string;
          status?: AppointmentStatus;
          calendar_event_id?: string | null;
          staff_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["appointments"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "appointments_business_id_fkey";
            columns: ["business_id"];
            isOneToOne: false;
            referencedRelation: "businesses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_service_id_fkey";
            columns: ["service_id"];
            isOneToOne: false;
            referencedRelation: "services";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_call_id_fkey";
            columns: ["call_id"];
            isOneToOne: false;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "appointments_staff_id_fkey";
            columns: ["staff_id"];
            isOneToOne: false;
            referencedRelation: "staff";
            referencedColumns: ["id"];
          },
        ];
      };
      call_events: {
        Row: {
          id: string;
          call_id: string;
          event_type: string;
          event_data: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          id?: string;
          call_id: string;
          event_type: string;
          event_data?: Record<string, unknown>;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["call_events"]["Insert"]>;
        Relationships: [];
      };
      vapi_business_map: {
        Row: {
          id: string;
          business_id: string;
          vapi_assistant_id: string | null;
          vapi_phone_number_id: string | null;
          label: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          business_id: string;
          vapi_assistant_id?: string | null;
          vapi_phone_number_id?: string | null;
          label?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["vapi_business_map"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {};
    Functions: {};
  };
}

export type Business = Database["public"]["Tables"]["businesses"]["Row"];
export type Service = Database["public"]["Tables"]["services"]["Row"];
export type Call = Database["public"]["Tables"]["calls"]["Row"];
export type Appointment = Database["public"]["Tables"]["appointments"]["Row"];
export type CallEvent = Database["public"]["Tables"]["call_events"]["Row"];
export type BusinessSettings = Database["public"]["Tables"]["business_settings"]["Row"];
export type Faq = Database["public"]["Tables"]["faqs"]["Row"];
export type Staff = Database["public"]["Tables"]["staff"]["Row"];
export type StaffAvailability = Database["public"]["Tables"]["staff_availability"]["Row"];
export type CallbackRequest = Database["public"]["Tables"]["callback_requests"]["Row"];
export type VapiBusinessMap = Database["public"]["Tables"]["vapi_business_map"]["Row"];
