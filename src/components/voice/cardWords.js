// The words on a voice card's Yes button and the hint under it. The button says what it does: "Log
// it" for food, a workout, a weight or a catch-up, "Save entry" for the journal, "Save" for the rest;
// anything that deletes keeps the plain "Yes, do it". Pure, with zero imports
// (tests/voice-client.test.mjs). Used by the call screen and the voice chat's card in the chat.

// Exact names: an edit (food_update_entry), a goal (food_set_goals) or a delete (food_delete_entry)
// must never read "Log it".
const LOG_TOOLS = new Set(['food_log', 'food_copy_entries', 'gym_quick_log', 'gym_log_workout', 'gym_log_bodyweight', 'log_contact'])
const DELETE_TOOLS = /(^|_)(delete|remove)(_|$)|^forget$|^archive/

export function cardWords(proposal) {
  const tools = (Array.isArray(proposal?.actions) ? proposal.actions : []).map((action) => String(action?.tool || '')).filter(Boolean)
  if (!tools.length || tools.some((tool) => DELETE_TOOLS.test(tool))) return { yes: 'Yes, do it', say: 'yes' }
  if (tools.every((tool) => LOG_TOOLS.has(tool))) return { yes: 'Log it', say: 'yes, log it' }
  if (tools.every((tool) => tool === 'write_journal')) return { yes: 'Save entry', say: 'yes, save it' }
  return { yes: 'Save', say: 'yes, save it' }
}
