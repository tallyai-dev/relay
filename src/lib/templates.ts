// Prospecting templates — one voice across reps, one text or email per moment.
// Source of truth for the Templates sheet on the lead card (mobile + desktop),
// the "Start from" chips in the email composer, and the pick-one product flow
// after "spoke · wants more info". Copy lives here so a wording change is one
// edit, not a hunt through components. Spec: Seth-Context/Relay-Prospecting-
// Templates-2026-09-10.md.
import type { Lead, Rep } from './types';

export const DEMO_LINE = '(385) 374-1473';        // Luna & Main, the demo salon
export const DEMO_LINK = 'https://gettallyai.com/demo';

export type Moment = {
  key: string;
  label: string;      // "No answer · call 1"
  when: string;       // "right after the first miss · no voicemail left"
  body: string;
};
export type EmailTpl = { key: string; label: string; when?: string; subject: string; body: string };
export type ProductTpl = EmailTpl & { product: string; price: string; cta: string };

export const TEXT_TEMPLATES: Moment[] = [
  { key: 'na1', label: 'No answer · call 1', when: 'right after the first miss · no voicemail left',
    body: "Hi{first_name}, {rep} with Tally — just tried you at {salon}. Quick one when you're between clients: who picks up when you're mid-color? (Reply STOP to opt out.)" },
  { key: 'vm', label: 'No answer · left voicemail', when: 'same day as call 2',
    body: "Hi{first_name}, {rep} again from Tally, left you a VM. 20-sec version: we answer the calls {salon} misses and text the client your booking link. Hear it live any time: {demo_line}" },
  { key: 'cb', label: 'Callback promised', when: 'the moment she says a time',
    body: "Perfect — I'll call you {callback_time}. If that changes, just text this number. — {rep}, Tally" },
  { key: 'cb15', label: 'Callback · 15 min before', when: 'just before you dial',
    body: "Hi{first_name}, {rep} here — calling you at {callback_time} like we said. Talk soon." },
  { key: 'info', label: 'Spoke · wants info', when: 'within 5 min of hanging up',
    body: "Great talking,{first_name}! Sending the {product} rundown to {email} now. The 2-min demo is here if you want it first: {link}" },
  { key: 'demo', label: 'Spoke · "send me the demo"', when: 'immediately',
    body: "Here you go,{first_name} — call Luna & Main, our demo salon, and book something: {demo_line}. That's exactly what {salon}'s callers would hear. Tell me what you think." },
  { key: 'gate', label: 'Front desk took a message', when: 'after the gatekeeper call',
    body: "Hi{first_name}, {rep} with Tally — left a message with your front desk today. 30 seconds of what it was about: {link}. Happy to catch you between clients." },
  { key: 'robot', label: 'Objection · "will it sound like a robot?"', when: 'reply to the objection',
    body: "Fair question. Don't take my word for it — call {demo_line} and try to trip it up. Then tell me if it'd embarrass {salon}." },
  { key: 'prep', label: 'Demo booked · day before', when: '4 pm the day before',
    body: "See you tomorrow at {meeting_time},{first_name}! It's 15 min on Zoom: {meeting_link}. Have your booking link handy and we'll set {salon} up on the call." },
  { key: 'noshow', label: 'Demo · no-show', when: '10 min after the start',
    body: "No worries if today got away from you,{first_name} — salons do that. Want to grab a new time? {calendly}" },
  { key: 'later', label: 'Not now · busy season', when: 'she asked for later',
    body: "Totally get it — {season} is chaos. I'll check back {when}. Meanwhile, if a missed call stings, the demo's here: {demo_line}" },
  { key: 'bye', label: 'Last touch · breakup', when: 'last step, no conversation',
    body: "Hi{first_name}, {rep} with Tally. I've tried a few times, so I'll stop here. If missed calls ever become the thing that bugs you at {salon}, this number still works." },
];

export const PRODUCT_TEMPLATES: ProductTpl[] = [
  { key: 'nightdesk', product: 'Night Desk', price: "$49/mo · answers only when you're closed", label: 'Night Desk', cta: 'Reply "yes"',
    subject: '{salon}: the calls after 6 pm',
    body: "Hi{first_name} — good talking today.\n\nNight Desk is the small one: Tally picks up only when {salon} is closed. The client hears a real-sounding receptionist, gets your booking link by text, and you see every call the next morning.\n\n$49/mo, 75 calls, no contract. One recovered color appointment covers it.\n\nHear it before you decide — call Luna & Main, our demo salon: {demo_line}.\n\nWant it on {salon} this week? Reply \"yes\" and I'll set it up — you don't touch anything technical.\n\n{rep} · Tally · {rep_cell}" },
  { key: 'fullvoice', product: '24/7 Receptionist', price: '$199/mo · answers every call', label: '24/7 Receptionist', cta: 'Reply "set it up"',
    subject: '{salon}: never a missed call again',
    body: "Hi{first_name} — thanks for the time today.\n\nThe 24/7 receptionist answers every call to {salon}, day or night, while your hands are in someone's hair. It books through your {booking_system} link, takes messages, and hands anything odd to you. You see all of it in one dashboard.\n\n$199/mo, month to month. The math we talked about: two recovered bookings a month and it's paid for.\n\nCall the demo salon and try to stump it: {demo_line}.\n\nReply \"set it up\" and we'll have it live in a day.\n\n{rep} · Tally · {rep_cell}" },
  { key: 'mct', product: 'Missed-Call Text-Back', price: '$49/mo · 30-day free trial', label: 'Missed-Call Text-Back', cta: 'Start free',
    subject: '{salon}: text every missed call back in 10 seconds',
    body: "Hi{first_name} —\n\nSimplest version of what we talked about: when {salon} misses a call, Tally texts the caller within seconds — \"Hey, sorry we missed you! Book here: [your link]\" — so she doesn't call the salon down the street.\n\n$49/mo after a 30-day free trial. Nothing to install, nothing charged today.\n\nStart it here: {link}\n\n{rep} · Tally · {rep_cell}" },
  { key: 'aitext', product: 'Tally Text Receptionist', price: '$99/mo · AI answers texts, too', label: 'Tally Text', cta: 'Watch 60 sec',
    subject: "{salon}: the texts you can't answer mid-service",
    body: "Hi{first_name} —\n\nYou said most of your booking questions come in by text. Tally Text answers them: pricing, availability, \"do you do extensions,\" and books through your {booking_system} link. You read the thread later; the client got her answer now.\n\n$99/mo, 400 texts. Works from your existing number.\n\nHere's a 60-second look: {link}\n\n{rep} · Tally · {rep_cell}" },
  { key: 'booth', product: 'Tally Booth', price: 'priced by suite count', label: 'Tally Booth', cta: 'Reply with suite count',
    subject: '{salon}: rent that collects itself',
    body: "Hi{first_name} —\n\nFor the suites: Tally Booth collects rent automatically, chases the late ones so you don't have to, and shows you who's paid at a glance. A salon down the road runs 14 renters on it.\n\nWe price it by suite count — tell me how many you have and I'll send the number.\n\n{rep} · Tally · {rep_cell}" },
];

export const EMAIL_TEMPLATES_LIB: EmailTpl[] = [
  { key: 'missed', label: 'No answer · after two tries', when: 'cadence step 4',
    subject: '{salon}: stop losing after-hours bookings',
    body: "Hi{first_name} — I've tried you twice this week, so figured email's easier.\n\n{salon} probably misses calls after you close. Tally answers them and texts the client your booking link, so she books with you instead of the salon that picked up.\n\n60-second demo: {link}\n\nWorth a 10-minute call? Reply with a time, or call the demo salon first: {demo_line}.\n\n{rep} · Tally" },
  { key: 'gate', label: 'Front desk took a message', when: 'to the owner, same day',
    subject: "Quick one about {salon}'s missed calls",
    body: "Hi{first_name} — your front desk kindly took a message today. Here's what it was about, in 30 seconds: {link}\n\nWhen calls hit voicemail at {salon}, Tally picks up and books them. I'd love 10 minutes to show you what your own callers would hear.\n\n{rep} · Tally · {rep_cell}" },
  { key: 'booking', label: 'Objection · "works with my booking system?"', when: 'reply to the objection',
    subject: 'Yes — Tally sits next to {booking_system}, not instead of it',
    body: "Hi{first_name} — short answer: yes.\n\nYour book doesn't change. Tally answers the call, then texts the client your {booking_system} link. She books herself, in your system, on your rules. No rip-and-replace, nothing to migrate.\n\nWant to see it with your actual link? Reply and I'll set up a 10-minute walkthrough.\n\n{rep} · Tally" },
  { key: 'recap', label: 'Recap of our call', when: 'after a real conversation',
    subject: 'Quick recap from our call',
    body: "Hi{first_name} — quick recap of what we covered for {salon}:\n\n- Tally answers the calls you miss and books them through your {booking_system} link\n- Works with your current number — nothing to install\n- Hear it any time: {demo_line}\n\nI'll follow up soon, but reply anytime if you want to move forward.\n\n{rep} · Tally · {rep_cell}" },
  { key: 'nurture', label: 'Nurture · monthly', when: '"not now" leads, once a month',
    subject: 'One thing from Tally this month',
    body: "Hi{first_name} — no pitch, one useful thing.\n\n{nurture_item}\n\nIf missed calls ever move up the list at {salon}, I'm a reply away.\n\n{rep} · Tally" },
];

// The rep's name is optional ("Sign as" on the lead's Templates sheet / Team).
// Blank = the message speaks as Tally, so every {rep} phrase is rewritten to
// read naturally without a person's name. Runs before the other tokens, and on
// admin overrides too, so an edited template degrades the same way.
export function fillRep(tpl: string, signName?: string | null): string {
  const n = (signName || '').trim();
  if (n) return tpl.replace(/\{rep\}/g, n);
  return tpl
    .replace(/[—–-]\s*\{rep\},\s*Tally\b/g, '— Tally')
    .replace(/\{rep\}\s*·\s*Tally\b/g, 'The Tally team')
    .replace(/It['’]s \{rep\} (?:from|with) Tally/g, "It's Tally")
    .replace(/\{rep\} again (?:from|with) Tally/g, 'Tally again')
    .replace(/\{rep\} (?:from|with) Tally again/g, 'Tally again')
    .replace(/\{rep\} (?:from|with) Tally/g, 'this is Tally')
    .replace(/\{rep\} here/g, 'this is Tally')
    .replace(/\{rep\}/g, 'the Tally team');
}

export interface TplContext {
  lead: Lead;
  me?: Rep | null;
  product?: string;
  callbackTime?: string;
  meetingTime?: string;
  meetingLink?: string;
  season?: string;
  when?: string;
  nurtureItem?: string;
  calendly?: string;
}

const fmtCell = (p?: string) => {
  const d = (p || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : (p || '');
};

// Fill every token. A missing value becomes a visible [placeholder] so the rep
// sees what to type, never a silent blank mid-sentence. {first_name} keeps the
// existing cadence convention: it carries its own leading space.
export function renderTpl(tpl: string, ctx: TplContext): string {
  const { lead, me } = ctx;
  const first = lead.contact?.name && lead.contact.name !== '—' ? lead.contact.name.split(' ')[0] : '';
  const rep = (me?.signName || '').trim();
  tpl = fillRep(tpl, rep);
  const v: Record<string, string> = {
    first_name: first ? ` ${first}` : '',
    salon: lead.salon,
    rep,
    rep_cell: fmtCell(me?.forwardTo || me?.phoneNumber) || '[your cell]',
    demo_line: DEMO_LINE,
    link: DEMO_LINK,
    calendly: ctx.calendly || '[calendly link]',
    booking_system: lead.bookingSystem || 'booking',
    city: lead.city || '',
    email: lead.email || '[her email]',
    product: ctx.product || '[product]',
    callback_time: ctx.callbackTime || '[time]',
    meeting_time: ctx.meetingTime || '[time]',
    meeting_link: ctx.meetingLink || '[zoom link]',
    season: ctx.season || '[this season]',
    when: ctx.when || '[when]',
    nurture_item: ctx.nurtureItem || '[one useful thing — a tip, a stat, a story]',
  };
  return tpl
    .replace(/\{([a-z_]+)\}/g, (m, k) => (k in v ? v[k] : m))
    .replace(/,\s*!/g, '!')          // "Great talking,!" when no first name
    .replace(/,\s*—/g, ' —')         // "…away from you, —" when no first name
    .replace(/\s+—/g, ' —')
    .replace(/Hi\s+—/g, 'Hi —');
}

// ── Overrides ────────────────────────────────────────────────────────────────
// Admins can rewrite any template in Relay → Templates. Overrides are keyed
// '<kind>:<key>' and hold the edited body (and subject for emails). Apply them
// with withOverrides() before rendering so the sheet, the composer, and Eryn's
// follow-up texts all say the same thing.
export type TplKind = 'text' | 'email' | 'product';
export type TplOverride = { subject?: string | null; body: string; updatedAt?: string };
export type TplOverrides = Record<string, TplOverride>;   // 'text:na1' → { body }

/** Which text templates Eryn sends automatically after her calls. */
export const ERYN_TEXT_KEYS: Record<string, string> = { na1: 'no answer · first try', vm: 'voicemail, or a later miss', gate: 'front desk took a message' };

export function withOverrides<T extends { key: string; body: string; subject?: string }>(list: T[], kind: TplKind, ov?: TplOverrides | null): T[] {
  if (!ov) return list;
  return list.map((t) => {
    const o = ov[`${kind}:${t.key}`];
    if (!o) return t;
    return { ...t, body: o.body, ...(t.subject !== undefined && o.subject ? { subject: o.subject } : {}) };
  });
}

/** The tokens a template may use, for the editor's legend. */
export const TPL_TOKENS: { token: string; means: string }[] = [
  { token: '{first_name}', means: "her first name, with its own leading space (blank when unknown — 'Hi{first_name},' reads fine either way)" },
  { token: '{salon}', means: 'salon name' },
  { token: '{rep}', means: "the sender's \"Sign as\" name — optional; when blank, the phrase reads as Tally (\"{rep} with Tally\" → \"this is Tally\")" },
  { token: '{rep_cell}', means: "the rep's cell, formatted" },
  { token: '{demo_line}', means: `the Luna & Main demo line (${DEMO_LINE})` },
  { token: '{link}', means: `the demo link (${DEMO_LINK})` },
  { token: '{booking_system}', means: "her booking software, or 'booking'" },
  { token: '{city}', means: 'her city' },
  { token: '{email}', means: 'her email' },
  { token: '{product}', means: 'the product she asked about (wants-info flow)' },
  { token: '{callback_time}', means: 'the time she named' },
  { token: '{meeting_time} {meeting_link} {calendly}', means: 'demo details' },
  { token: '{season} {when} {nurture_item}', means: 'fill-ins for the later / nurture templates' },
];
