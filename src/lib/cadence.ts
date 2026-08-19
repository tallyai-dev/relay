import type { Cadence, CadenceStep, Lead, Stage, Channel, Disposition, DispositionKey, BranchAction, Branches } from './types';

/**
 * The cadence engine — the brain behind Flow Mode.
 *
 * A lead's "plan" for a working session is the ordered list of channels it
 * should run through given its stage. New/cold salons get the full
 * call → call → text → email sequence ("call twice, then text + email");
 * warmer stages get shorter plans.
 *
 * The engine is pure and deterministic so it can run identically on the client
 * (Flow queue) and on the server (scheduled next-action jobs).
 */

export function planForStage(stage: Stage): Channel[] {
  switch (stage) {
    case 'new':
    case 'cold':
      return ['call', 'call', 'text', 'email'];
    case 'working':
      return ['call', 'text'];
    case 'hot':
      return ['call']; // straight to a close attempt
    default:
      return ['call'];
  }
}

/** Expand a lead into its ordered list of channels for this session. */
export function planForLead(lead: Lead, _cadence?: Cadence): Channel[] {
  return planForStage(lead.stage);
}

/** For a call at plan index `stepIndex`, which attempt is it and how many total. */
export function callAttempt(plan: Channel[], stepIndex: number) {
  const totalCalls = plan.filter((c) => c === 'call').length;
  const attempt = plan.slice(0, stepIndex + 1).filter((c) => c === 'call').length;
  return { attempt, totalCalls };
}

/**
 * Given the outcome of the current step, return how the lead should advance.
 * - onward: continue to the next step in the plan
 * - salon_done: stop this lead (booked / not interested / wrong number)
 * - next stage change (optional) for stage transitions.
 */
export interface AdvanceResult {
  advance: 'onward' | 'salon_done';
  newStage?: Stage;
}

export function resolveOutcome(disposition: Disposition): AdvanceResult {
  switch (disposition) {
    case 'no_answer':
    case 'voicemail':
      return { advance: 'onward' };
    case 'connected':
      return { advance: 'onward' }; // connected is followed by a sub-outcome
    case 'booked':
      return { advance: 'salon_done', newStage: 'hot' };
    case 'quote':
      return { advance: 'salon_done', newStage: 'hot' };
    case 'callback':
      return { advance: 'salon_done', newStage: 'working' };
    case 'not_interested':
      return { advance: 'salon_done', newStage: 'cold' };
    case 'wrong_number':
      return { advance: 'salon_done', newStage: 'cold' };
    default:
      return { advance: 'onward' };
  }
}

/** Merge {salon} and {first_name} into a template. */
export function renderTemplate(tpl: string, lead: Lead): string {
  const first =
    lead.contact?.name && lead.contact.name !== '—'
      ? lead.contact.name.split(' ')[0]
      : '';
  return tpl
    .replaceAll('{salon}', lead.salon)
    .replaceAll('{first_name}', first ? ` ${first}` : '')
    .replace(/\s+—/, ' —');
}

export const DEFAULT_SMS =
  'Hi{first_name} — Seth here. Quick idea for {salon}: an AI receptionist that answers your missed & after-hours calls so you stop losing bookings. Worth a 2-min look?';

export const DEFAULT_EMAIL_SUBJECT = '{salon}: stop losing after-hours bookings';
export const DEFAULT_EMAIL_BODY =
  'Hi{first_name} — noticed {salon} probably misses calls after you close. We set salons up with a 24/7 AI receptionist that answers and books them. 60-second demo inside — worth a look?';

// ── Disposition branching ────────────────────────────────────────────────────
// The six outcomes a call can end in. `no_answer/voicemail/wrong_number` are the
// call-level results; `booked/callback/not_interested` are the "Connected" sub-
// outcomes. Each Call step in a cadence can route every outcome independently.
export const DISPOSITIONS: { key: DispositionKey; label: string; short: string; group: 'call' | 'connected' }[] = [
  { key: 'no_answer', label: 'No answer', short: 'No answer', group: 'call' },
  { key: 'voicemail', label: 'Left voicemail', short: 'Voicemail', group: 'call' },
  { key: 'wrong_number', label: 'Wrong / bad number', short: 'Wrong #', group: 'call' },
  { key: 'booked', label: 'Connected — Booked', short: 'Booked', group: 'connected' },
  { key: 'callback', label: 'Connected — Callback', short: 'Callback', group: 'connected' },
  { key: 'not_interested', label: 'Connected — Not interested', short: 'Not interested', group: 'connected' },
];

export const DISPO_LABEL: Record<DispositionKey, string> = {
  no_answer: 'Call — no answer', voicemail: 'Call — left voicemail', wrong_number: 'Call — wrong/dead number',
  booked: 'Demo booked', callback: 'Callback scheduled', not_interested: 'Not interested',
};

// Sensible defaults applied when a step hasn't customized a given outcome.
export const DEFAULT_BRANCHES: Record<DispositionKey, BranchAction> = {
  no_answer: { type: 'continue' },
  voicemail: { type: 'continue' },
  wrong_number: { type: 'stop', stage: 'cold' },
  booked: { type: 'stop', stage: 'hot' },
  callback: { type: 'wait', days: 2 },
  not_interested: { type: 'stop', stage: 'cold' },
};

export function branchFor(step: CadenceStep | undefined, key: DispositionKey): BranchAction {
  return step?.branches?.[key] || DEFAULT_BRANCHES[key];
}

export function describeBranch(a: BranchAction): string {
  switch (a.type) {
    case 'continue': return 'Continue to next step';
    case 'send': return `Send ${a.channel === 'text' ? 'a text' : 'an email'}, then continue`;
    case 'wait': return `Wait ${a.days} day${a.days === 1 ? '' : 's'}, then re-touch`;
    case 'stop': return `Stop — mark ${a.stage[0].toUpperCase() + a.stage.slice(1)}`;
  }
}

/** AI note bodies per disposition (placeholder for a real transcription/LLM step). */
export const AI_NOTE: Record<string, string> = {
  booked:
    '✦ Owner agreed to a demo. Warm on the after-hours pain — wants pricing in writing after the call.',
  callback:
    '✦ Interested but busy — asked for a callback. Lead with the missed-call revenue angle next time.',
  not_interested:
    '✦ Not interested right now; says current setup is fine. Worth a re-touch in ~60 days.',
  quote: '✦ Sent the 24/7 plan — $199/mo, setup waived.',
  voicemail:
    '✦ No pickup. Left a voicemail about after-hours missed calls; nudging by text next.',
  no_answer: '✦ No answer. Auto-advancing per cadence.',
  wrong_number: 'Number disconnected — flagged for data cleanup.',
};
