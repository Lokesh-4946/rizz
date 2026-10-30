/**
 * Session-start injection budget (D-050).
 *
 * The newest handoff is placed first and capped at {@link HANDOFF_CONTEXT_CAP}
 * characters, including its heading. `BRAIN.md` follows as the index and receives
 * every remaining character up to {@link SESSION_CONTEXT_BUDGET}. A short handoff
 * does not raise the handoff cap; the unused characters go to the index. The split
 * does not depend on anything except those two caps and the text lengths.
 *
 * The newest handoff file is the greatest mtime. Equal mtimes use the greater file name.
 */
export const SESSION_CONTEXT_BUDGET = 6000;
export const HANDOFF_CONTEXT_CAP = 2400;

const HANDOFF_HEADING = '## Latest handoff\n\n';
const INDEX_HEADING = '## Brain index\n\n';
const SECTION_GAP = '\n\n';

function capped(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/** Handoff section first, then the brain index, never past the 6000-character budget. */
export function composeSessionContext(brain: string, handoff: string | undefined): string {
  const note = (handoff ?? '').trim();
  const index = brain.trim();
  if (note === '') {
    if (index === '') return 'Rizz brain index is empty.';
    return capped(index, SESSION_CONTEXT_BUDGET);
  }
  const handoffRoom = HANDOFF_CONTEXT_CAP - HANDOFF_HEADING.length;
  const handoffSection = capped(
    `${HANDOFF_HEADING}${capped(note, handoffRoom)}`,
    HANDOFF_CONTEXT_CAP,
  );
  if (index === '') return capped(handoffSection, SESSION_CONTEXT_BUDGET);
  const remaining = SESSION_CONTEXT_BUDGET - handoffSection.length - SECTION_GAP.length;
  if (remaining <= INDEX_HEADING.length) return capped(handoffSection, SESSION_CONTEXT_BUDGET);
  const indexBody = capped(index, remaining - INDEX_HEADING.length);
  return capped(
    `${handoffSection}${SECTION_GAP}${INDEX_HEADING}${indexBody}`,
    SESSION_CONTEXT_BUDGET,
  );
}
