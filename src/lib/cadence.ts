import type { Cadence, Lead, Stage, Channel, Disposition } from './types';

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
