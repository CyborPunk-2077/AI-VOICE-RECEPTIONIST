// Mock data only — no external services, no persistence.
// ReceptionFlow is a fictional salon; all data below is synthetic.

export type CallIntent = "FAQ" | "Booking" | "Transfer";
export type CallOutcome = "FAQ Answered" | "Booked" | "Transferred" | "No Match";

export interface CallLog {
  id: string;
  callerName: string;
  callerNumber: string;
  startedAt: string; // ISO
  durationSeconds: number;
  intent: CallIntent;
  outcome: CallOutcome;
  summary: string;
}

export type BookingStatus = "Confirmed" | "Completed" | "Cancelled";

export interface Appointment {
  id: string;
  customerName: string;
  customerPhone: string;
  service: "Haircut" | "Color" | "Blowout";
  startTime: string; // ISO
  durationMinutes: number;
  status: BookingStatus;
  callId: string;
}

export interface ServiceConfig {
  id: string;
  name: "Haircut" | "Color" | "Blowout";
  durationMinutes: number;
  price: number;
  description: string;
}

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  active: boolean;
  timesAsked: number;
}

export const salon = {
  name: "Lumen Salon",
  address: "214 Birch Street, Portland, OR 97205",
  phone: "(503) 555-0148",
  timezone: "America/Los_Angeles",
  hours: "Mon–Sat, 9:00 AM–7:00 PM (closed Sunday)",
};

export const services: ServiceConfig[] = [
  {
    id: "svc_haircut",
    name: "Haircut",
    durationMinutes: 45,
    price: 65,
    description: "Wash, cut, and style with a senior stylist.",
  },
  {
    id: "svc_color",
    name: "Color",
    durationMinutes: 120,
    price: 180,
    description: "Full color or balayage, includes gloss and blowout.",
  },
  {
    id: "svc_blowout",
    name: "Blowout",
    durationMinutes: 30,
    price: 45,
    description: "Wash and professional blowout styling.",
  },
];

export const faqs: FaqItem[] = [
  {
    id: "faq_hours",
    question: "What are your hours?",
    answer: "We're open Monday through Saturday, 9 AM to 7 PM. Closed on Sundays.",
    active: true,
    timesAsked: 42,
  },
  {
    id: "faq_location",
    question: "Where are you located?",
    answer: "214 Birch Street, Portland, OR — street parking and a lot behind the building.",
    active: true,
    timesAsked: 31,
  },
  {
    id: "faq_parking",
    question: "Is there parking?",
    answer: "Yes, free street parking plus a small lot behind the building.",
    active: true,
    timesAsked: 18,
  },
  {
    id: "faq_walkins",
    question: "Do you accept walk-ins?",
    answer: "We're appointment-first, but we'll always try to fit walk-ins in when we have room.",
    active: true,
    timesAsked: 15,
  },
  {
    id: "faq_cancel",
    question: "What's your cancellation policy?",
    answer: "Please give us 24 hours notice — cancellations after that may include a small fee.",
    active: true,
    timesAsked: 9,
  },
  {
    id: "faq_products",
    question: "What hair products do you use?",
    answer: "We carry Oribe and Davines — both available for purchase in-salon.",
    active: true,
    timesAsked: 6,
  },
];

// Questions the agent could not answer from the approved FAQ list.
export const faqMisses = [
  { id: "miss_1", question: "Do you do keratin treatments?", askedAt: "2026-07-31T14:12:00-07:00" },
  { id: "miss_2", question: "Can I bring my kid with me to my appointment?", askedAt: "2026-07-31T11:40:00-07:00" },
  { id: "miss_3", question: "Do you offer bridal packages?", askedAt: "2026-07-30T16:05:00-07:00" },
  { id: "miss_4", question: "What brand of hair color do you use?", askedAt: "2026-07-29T10:22:00-07:00" },
];

export const calls: CallLog[] = [
  {
    id: "call_1001",
    callerName: "Maya Chen",
    callerNumber: "(503) 555-0112",
    startedAt: "2026-07-31T09:14:00-07:00",
    durationSeconds: 132,
    intent: "Booking",
    outcome: "Booked",
    summary: "Booked a Haircut for Aug 2 at 2:00 PM.",
  },
  {
    id: "call_1002",
    callerName: "Unknown Caller",
    callerNumber: "(971) 555-0184",
    startedAt: "2026-07-31T09:47:00-07:00",
    durationSeconds: 58,
    intent: "FAQ",
    outcome: "FAQ Answered",
    summary: "Asked about parking availability.",
  },
  {
    id: "call_1003",
    callerName: "Devon Ross",
    callerNumber: "(503) 555-0199",
    startedAt: "2026-07-31T10:22:00-07:00",
    durationSeconds: 201,
    intent: "Booking",
    outcome: "Booked",
    summary: "Booked a Color appointment for Aug 3 at 11:00 AM.",
  },
  {
    id: "call_1004",
    callerName: "Priya Patel",
    callerNumber: "(503) 555-0167",
    startedAt: "2026-07-31T11:05:00-07:00",
    durationSeconds: 47,
    intent: "FAQ",
    outcome: "No Match",
    summary: "Asked if kids can come to appointments — outside approved FAQ list, offered transfer.",
  },
  {
    id: "call_1005",
    callerName: "Sam Whitfield",
    callerNumber: "(503) 555-0143",
    startedAt: "2026-07-31T11:38:00-07:00",
    durationSeconds: 96,
    intent: "Transfer",
    outcome: "Transferred",
    summary: "Wanted to speak with the manager about a prior service issue.",
  },
  {
    id: "call_1006",
    callerName: "Unknown Caller",
    callerNumber: "(503) 555-0129",
    startedAt: "2026-07-31T12:15:00-07:00",
    durationSeconds: 22,
    intent: "FAQ",
    outcome: "No Match",
    summary: "Call dropped before intent could be resolved.",
  },
  {
    id: "call_1007",
    callerName: "Grace Kim",
    callerNumber: "(503) 555-0155",
    startedAt: "2026-07-31T13:02:00-07:00",
    durationSeconds: 144,
    intent: "Booking",
    outcome: "Booked",
    summary: "Booked a Blowout for Aug 1 at 4:30 PM.",
  },
  {
    id: "call_1008",
    callerName: "Unknown Caller",
    callerNumber: "(503) 555-0177",
    startedAt: "2026-07-31T13:40:00-07:00",
    durationSeconds: 39,
    intent: "FAQ",
    outcome: "FAQ Answered",
    summary: "Asked about the cancellation policy.",
  },
  {
    id: "call_1009",
    callerName: "Lena Ortiz",
    callerNumber: "(503) 555-0188",
    startedAt: "2026-07-31T14:12:00-07:00",
    durationSeconds: 61,
    intent: "FAQ",
    outcome: "No Match",
    summary: "Asked about keratin treatments — outside approved FAQ list.",
  },
  {
    id: "call_1010",
    callerName: "Owen Brooks",
    callerNumber: "(503) 555-0121",
    startedAt: "2026-07-31T15:03:00-07:00",
    durationSeconds: 178,
    intent: "Booking",
    outcome: "Transferred",
    summary: "Requested a same-day slot with no availability; transferred to front desk.",
  },
];

export const appointments: Appointment[] = [
  {
    id: "book_2001",
    customerName: "Grace Kim",
    customerPhone: "(503) 555-0155",
    service: "Blowout",
    startTime: "2026-08-01T16:30:00-07:00",
    durationMinutes: 30,
    status: "Confirmed",
    callId: "call_1007",
  },
  {
    id: "book_2002",
    customerName: "Maya Chen",
    customerPhone: "(503) 555-0112",
    service: "Haircut",
    startTime: "2026-08-02T14:00:00-07:00",
    durationMinutes: 45,
    status: "Confirmed",
    callId: "call_1001",
  },
  {
    id: "book_2003",
    customerName: "Devon Ross",
    customerPhone: "(503) 555-0199",
    service: "Color",
    startTime: "2026-08-03T11:00:00-07:00",
    durationMinutes: 120,
    status: "Confirmed",
    callId: "call_1003",
  },
  {
    id: "book_2004",
    customerName: "Halle Jensen",
    customerPhone: "(503) 555-0134",
    service: "Haircut",
    startTime: "2026-08-04T10:00:00-07:00",
    durationMinutes: 45,
    status: "Confirmed",
    callId: "call_0994",
  },
  {
    id: "book_2005",
    customerName: "Marcus Webb",
    customerPhone: "(503) 555-0161",
    service: "Blowout",
    startTime: "2026-08-05T09:30:00-07:00",
    durationMinutes: 30,
    status: "Confirmed",
    callId: "call_0988",
  },
  {
    id: "book_2006",
    customerName: "Nora Fitzgerald",
    customerPhone: "(503) 555-0142",
    service: "Color",
    startTime: "2026-07-29T13:00:00-07:00",
    durationMinutes: 120,
    status: "Completed",
    callId: "call_0961",
  },
  {
    id: "book_2007",
    customerName: "Ethan Cole",
    customerPhone: "(503) 555-0119",
    service: "Haircut",
    startTime: "2026-07-28T15:15:00-07:00",
    durationMinutes: 45,
    status: "Completed",
    callId: "call_0947",
  },
  {
    id: "book_2008",
    customerName: "Ines Alvarez",
    customerPhone: "(503) 555-0175",
    service: "Blowout",
    startTime: "2026-07-27T11:45:00-07:00",
    durationMinutes: 30,
    status: "Cancelled",
    callId: "call_0930",
  },
];

export function getTodayStats() {
  const today = calls; // all mock calls are "today" for demo purposes
  return {
    callsToday: today.length,
    bookingsToday: today.filter((c) => c.outcome === "Booked").length,
    humanTransfers: today.filter((c) => c.outcome === "Transferred").length,
    missedCalls: today.filter((c) => c.outcome === "No Match").length,
  };
}
