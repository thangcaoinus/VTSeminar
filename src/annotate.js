// annotate.js — prerequisite/context fields for a talk.
//
// Extraction rules (follow exactly):
//   DO extract: prerequisites (concrete topics/courses), related_concepts, one_line_context.
//   DO NOT invent a "beginner-friendly"/difficulty/accessibility rating — biggest hallucination risk.
//   Do not invent missing data. Every annotation is flagged ai_generated: true.
//
// Annotation is allowed to happen in the same Gemini call as extraction (see extract.js's
// responseSchema, which already includes annotations). This module exists for the case where
// you'd rather do it as a follow-up call per talk.
//
// TODO(build): implement if/when annotation is split out of the extraction call.

/**
 * @param {object} talk  a talk missing/with-empty annotations
 * @param {object} opts  { model, apiKey }
 * @returns {Promise<object>} talk with annotations populated (ai_generated: true)
 */
export async function annotateTalk(talk, opts) {
  void opts;
  // Scaffold: pass through. In the default design, annotations come from extract.js.
  return talk;
}
