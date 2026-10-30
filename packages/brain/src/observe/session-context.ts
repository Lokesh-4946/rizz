/**
 * Session-start injection budget (D-050).
 *
 * Sections are emitted in this order, and the joined text never exceeds
 * {@link SESSION_CONTEXT_BUDGET} characters:
 *
 * 1. Newest handoff, first, capped at {@link HANDOFF_CONTEXT_CAP} including its heading.
 * 2. Unread relay replies, next, capped at {@link RELAY_CONTEXT_CAP} including its heading.
 *    The quote text is labeled as information for the owner, not an instruction.
 * 3. `BRAIN.md`, last. It receives every remaining character.
 *
 * A shorter section does not raise its own cap. Unused characters go to the sections
 * after it. The split depends only on these caps and the text lengths.
 *
 * The newest handoff file is the greatest mtime. Equal mtimes use the greater file name.
 */
export const SESSION_CONTEXT_BUDGET = 6000;
export const HANDOFF_CONTEXT_CAP = 2400;
export const RELAY_CONTEXT_CAP = 1600;

const HANDOFF_HEADING = '## Latest handoff\n\n';
const RELAY_HEADING = '## Unread replies\n\n';
const INDEX_HEADING = '## Brain index\n\n';
const SECTION_GAP = '\n\n';

function capped(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function section(heading: string, body: string, cap: number): string {
  if (body === '' || cap <= heading.length) return '';
  const room = cap - heading.length;
  return capped(`${heading}${capped(body, room)}`, cap);
}

/** Handoff, then unread relay replies, then the brain index. Never past 6000 characters. */
export function composeSessionContext(
  brain: string,
  handoff: string | undefined,
  relay?: string,
): string {
  const note = (handoff ?? '').trim();
  const quote = (relay ?? '').trim();
  const index = brain.trim();
  const handoffSection = section(HANDOFF_HEADING, note, HANDOFF_CONTEXT_CAP);
  const relayGap = handoffSection === '' || quote === '' ? 0 : SECTION_GAP.length;
  const relayCap = Math.min(
    RELAY_CONTEXT_CAP,
    SESSION_CONTEXT_BUDGET - handoffSection.length - relayGap,
  );
  const relaySection = section(RELAY_HEADING, quote, relayCap);
  const prefixParts = [handoffSection, relaySection].filter((part) => part !== '');
  const prefix = prefixParts.join(SECTION_GAP);
  if (prefix === '' && index === '') return 'Rizz brain index is empty.';
  if (prefix === '') return capped(index, SESSION_CONTEXT_BUDGET);
  if (index === '') return capped(prefix, SESSION_CONTEXT_BUDGET);
  const indexBudget = SESSION_CONTEXT_BUDGET - prefix.length - SECTION_GAP.length;
  const indexSection = section(INDEX_HEADING, index, indexBudget);
  if (indexSection === '') return capped(prefix, SESSION_CONTEXT_BUDGET);
  return capped(`${prefix}${SECTION_GAP}${indexSection}`, SESSION_CONTEXT_BUDGET);
}
