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
  bookingSystem?: string;
  source?: string;
  stage: Stage;
  cadenceId: string;
  cadencePos: number;
  contact?: Contact;
  lastTouch?: string;
  objection?: string;
}

export interface CadenceStep {
  position: number;
  channel: Channel;
  waitMinutes: number;
  template?: string;
  subject?: string;
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
}

// A single unit of work Flow hands the rep, produced by the cadence engine.
export interface FlowAction {
  leadId: string;
  channel: 'call' | 'text' | 'email';
  attempt?: number;     // for calls: which attempt (1-based)
  totalCalls?: number;  // total call steps in this lead's plan
  stepIndex: number;    // index within the lead's expanded plan
}
