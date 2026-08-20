export type Stage = 'new' | 'working' | 'hot' | 'won' | 'cold';
export type Channel = 'call' | 'text' | 'email' | 'wait';
export type Disposition =
  | 'no_answer' | 'voicemail' | 'connected' | 'wrong_number'
  | 'booked' | 'callback' | 'quote' | 'not_interested';

export interface Rep {
  id: string;
  name: string;
  email?: string;
  role: 'admin' | 'rep';
  phoneNumber?: string; // their assigned outbound Twilio number (caller ID)
  active?: boolean;     // deactivated reps can't be assigned new work
  leadCount?: number;   // owned leads, filled on the Team screen
}

export interface Contact {
  id: string;
  name: string;
  role: string; // Owner | Manager | Front desk
  phone?: string;
  email?: string;
}

export interface Lead {
  id: string;
  salon: string;
  city?: string;
  phone?: string;
  email?: string;
  website?: string;
  bookingSystem?: string;
  source?: string;
  stage: Stage;
  cadenceId: string;
  cadencePos: number;
  cadenceCompletedAt?: string;   // ISO — set when the lead finishes its whole cadence
  cadenceCompletedName?: string; // name of the cadence they completed (snapshot)
  deployed?: boolean;    // false = sitting in the staging pool, not yet in a cadence
  nextActionAt?: string; // ISO — when this lead is next due (null = due now / never scheduled)
  ownerRepId?: string;   // the rep this lead is assigned to (null = unassigned pool)
  contact?: Contact;
  lastTouch?: string;
  objection?: string;
}

// Disposition-based branching: after a Call step, what each outcome does next.
export type DispositionKey = 'no_answer' | 'voicemail' | 'wrong_number' | 'booked' | 'callback' | 'not_interested';

export type BranchAction =
  | { type: 'continue' }                       // go to the next step in the cadence
  | { type: 'send'; channel: 'text' | 'email' } // fire a text/email now, then continue
  | { type: 'wait'; days: number }             // snooze this lead, re-touch in N days
  | { type: 'stop'; stage: Stage };            // end the cadence + set the lead's stage

export type Branches = Partial<Record<DispositionKey, BranchAction>>;

export interface CadenceStep {
  position: number;
  channel: Channel;
  waitMinutes: number;
  template?: string;
  subject?: string;
  branches?: Branches; // only meaningful on Call steps
}

export interface Cadence {
  id: string;
  name: string;
  steps: CadenceStep[];
}

export type ActivityKind = 'call' | 'text' | 'email' | 'note' | 'book' | 'quote' | 'system';

export interface Activity {
  id: string;
  leadId: string;
  kind: ActivityKind;
  direction?: 'out' | 'in';
  disposition?: Disposition;
  ty: string;      // display label, e.g. "Call — connected"
  time: string;    // display time
  ai?: boolean;    // show AI-summary chip
  aiNote?: string;
  ownNote?: string;
  body?: string;
  recordingUrl?: string; // call recording (playable) when present
  transcript?: string;   // full call transcript
  durationS?: number;    // call length in seconds
}

export interface Message {
  id: string;
  leadId?: string;
  who: string;
  salon: string;
  channel: 'text' | 'email';
  direction: 'out' | 'in';
  subject?: string;
  body: string;
  time: string;
  isRead: boolean;
  phone?: string;    // the counterpart number (their number), for threading when no lead
  pending?: boolean; // optimistic send in flight
  failed?: boolean;  // provider rejected the send
  openCount?: number;  // outbound email: times the tracking pixel loaded
  clickCount?: number; // outbound email: times a tracked link was clicked
}

// A single unit of work Flow hands the rep, produced by the cadence engine.
export interface FlowAction {
  leadId: string;
  channel: 'call' | 'text' | 'email';
  attempt?: number;     // for calls: which attempt (1-based)
  totalCalls?: number;  // total call steps in this lead's plan
  stepIndex: number;    // index within the lead's expanded plan
}
