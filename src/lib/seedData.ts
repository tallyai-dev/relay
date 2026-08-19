import type { Lead, Activity, Message } from './types';

// Local mock data so the app runs and is clickable before Supabase is wired.
// Mirrors the prototype's book of salons.

export const SEED_LEADS: Lead[] = [
  { id: 'l1', salon: 'Luxe Hair Studio', city: 'Portland, ME', phone: '(207) 555-0142', stage: 'working', cadenceId: 'c1', cadencePos: 1, objection: 'Timing', lastTouch: 'Texted · 1d', contact: { id: 'ct1', name: 'Dana Ortiz', role: 'Owner', phone: '(207) 555-0142' } },
  { id: 'l2', salon: 'The Mane Room', city: 'Boise, ID', phone: '(208) 555-0198', stage: 'new', cadenceId: 'c1', cadencePos: 0, objection: 'Gatekeeper', lastTouch: 'New · 3d', contact: { id: 'ct2', name: '—', role: 'Front desk' } },
  { id: 'l3', salon: 'Shear Bliss Salon', city: 'Provo, UT', phone: '(801) 555-0110', stage: 'hot', cadenceId: 'c1', cadencePos: 3, objection: 'Price / contract', lastTouch: 'Called · 4h', contact: { id: 'ct3', name: 'Marisol Vega', role: 'Owner', phone: '(801) 555-0110' } },
  { id: 'l4', salon: 'Copper + Comb', city: 'Tacoma, WA', phone: '(253) 555-0122', stage: 'working', cadenceId: 'c1', cadencePos: 2, objection: 'Timing', lastTouch: 'Called · 6h', contact: { id: 'ct4', name: 'Ryan Bell', role: 'Manager', phone: '(253) 555-0122' } },
  { id: 'l5', salon: 'Halo Blow Dry Bar', city: 'Mesa, AZ', phone: '(480) 555-0177', stage: 'working', cadenceId: 'c1', cadencePos: 1, nextActionAt: new Date(Date.now() + 2 * 864e5).toISOString(), objection: 'Timing', lastTouch: 'Emailed · 2d', contact: { id: 'ct5', name: 'Priya N.', role: 'Owner', phone: '(480) 555-0177' } },
  { id: 'l6', salon: 'Golden Shears Co.', city: 'Meridian, ID', phone: '(208) 555-0165', stage: 'hot', cadenceId: 'c1', cadencePos: 4, objection: 'Price / contract', lastTouch: 'Demo done · 1d', contact: { id: 'ct6', name: 'Tom Alvarez', role: 'Owner', phone: '(208) 555-0165' } },
  { id: 'l7', salon: 'Velvet & Vine Salon', city: 'Bend, OR', phone: '(541) 555-0139', stage: 'new', cadenceId: 'c1', cadencePos: 0, objection: 'Gatekeeper', lastTouch: 'New · 5h', contact: { id: 'ct7', name: 'Erin D.', role: 'Owner', phone: '(541) 555-0139' } },
  { id: 'l8', salon: 'Ivy & Oak Studio', city: 'Ogden, UT', phone: '(801) 555-0155', stage: 'cold', cadenceId: 'c1', cadencePos: 2, objection: 'No answer', lastTouch: 'Called · 1d', contact: { id: 'ct8', name: '—', role: '—' } },
  // Staged pool — imported, waiting to be deployed into a cadence.
  { id: 's1', salon: 'Willow & Wren Salon', city: 'Denver, CO', phone: '(303) 555-0181', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs1', name: '—', role: 'Front desk' } },
  { id: 's2', salon: 'Copperline Barbers', city: 'Denver, CO', phone: '(303) 555-0192', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs2', name: '—', role: 'Front desk' } },
  { id: 's3', salon: 'Bloom Beauty Bar', city: 'Aurora, CO', phone: '(720) 555-0143', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs3', name: 'Marta L.', role: 'Owner' } },
  { id: 's4', salon: 'The Cutting Room', city: 'Boulder, CO', phone: '(303) 555-0177', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs4', name: '—', role: 'Front desk' } },
  { id: 's5', salon: 'Gilded Mane Studio', city: 'Fort Collins, CO', phone: '(970) 555-0166', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs5', name: 'Priya K.', role: 'Owner' } },
  { id: 's6', salon: 'Sage & Shear', city: 'Littleton, CO', phone: '(303) 555-0159', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs6', name: '—', role: 'Front desk' } },
  { id: 's7', salon: 'Honeycomb Hair Co.', city: 'Lakewood, CO', phone: '(720) 555-0128', stage: 'new', cadenceId: 'c1', cadencePos: 0, deployed: false, objection: 'New', lastTouch: 'New', contact: { id: 'cs7', name: '—', role: 'Front desk' } },
];

export const SEED_ACTIVITIES: Record<string, Activity[]> = {
  l1: [
    { id: 'a1', leadId: 'l1', kind: 'call', ty: 'Call — connected', time: 'Aug 17 · 4:05 PM · 6m40s', ai: true, aiNote: 'Talked through the after-hours problem. Dana confirmed they miss 10–15 calls a week after 8 PM. Asked to be called back at 10 AM today with pricing in writing.' },
    { id: 'a2', leadId: 'l1', kind: 'text', ty: 'Text sent', time: 'Aug 16 · 9:12 AM', body: '"Hi Dana — Seth here, following up on the missed-call idea for Luxe. Free for 2 min tomorrow AM?"' },
    { id: 'a3', leadId: 'l1', kind: 'email', ty: 'Email — opened 3×', time: 'Aug 15 · 8:40 AM', body: 'Intro: "How Luxe can stop losing after-hours bookings." Opened 3 times, no reply.' },
    { id: 'a4', leadId: 'l1', kind: 'note', ty: 'Manual note', time: 'Aug 15', body: 'Found on IG — 2 locations, books through Vagaro. Owner is Dana, active on stories.' },
  ],
  l3: [
    { id: 'a5', leadId: 'l3', kind: 'call', ty: 'Call — connected', time: 'Aug 18 · 9:15 AM · 5m', ai: true, aiNote: 'Marisol wants pricing in writing before committing to a demo. Interested in text receptionist specifically.' },
  ],
  l6: [
    { id: 'a6', leadId: 'l6', kind: 'book', ty: 'Demo completed', time: 'Aug 17 · 2:00 PM', body: '30-min walkthrough. Tom loved the 24/7 answer + booking. Wants to start with one location, 90-day out.' },
    { id: 'a7', leadId: 'l6', kind: 'note', ty: 'Manual note', time: 'Aug 17', body: 'Decision maker confirmed. Send agreement + quote for $199/mo, waive setup.' },
  ],
};

export const SESSION_QUEUE = ['l1', 'l5', 'l6', 'l4', 'l3', 'l7', 'l8'];

// Seed inbox threads (mock mode). Grouped by leadId in the Inbox view.
export const SEED_MESSAGES: Message[] = [
  { id: 'm1', leadId: 'l4', who: 'Ryan Bell', salon: 'Copper + Comb', channel: 'text', direction: 'out', body: 'Hi Ryan — Seth here. Quick idea for Copper + Comb: an AI receptionist that answers your missed & after-hours calls. Worth a look?', time: 'Yest 1:12p', isRead: true },
  { id: 'm2', leadId: 'l4', who: 'Ryan Bell', salon: 'Copper + Comb', channel: 'text', direction: 'in', body: 'Sounds interesting, what does it cost?', time: '9:24a', isRead: false },
  { id: 'm3', leadId: 'l3', who: 'Marisol Vega', salon: 'Shear Bliss Salon', channel: 'email', direction: 'in', subject: 'Re: stop losing after-hours bookings', body: 'Hi Seth — can you send pricing before we set up a demo? Interested in the text option specifically. — Marisol', time: 'Today 8:10a', isRead: false },
  { id: 'm4', leadId: 'l6', who: 'Tom Alvarez', salon: 'Golden Shears Co.', channel: 'text', direction: 'out', body: 'Great — sending a calendar invite for Fri 11:15.', time: 'Yest 4:40p', isRead: true },
  { id: 'm5', leadId: 'l6', who: 'Tom Alvarez', salon: 'Golden Shears Co.', channel: 'text', direction: 'in', body: 'Confirmed for the demo 👍', time: 'Yest 5:02p', isRead: true },
  { id: 'm6', leadId: 'l5', who: 'Priya N.', salon: 'Halo Blow Dry Bar', channel: 'text', direction: 'in', body: 'Not right now, thanks', time: '2d', isRead: true },
];
