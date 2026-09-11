// ORPHANED - superseded by the real implementation (rutaAiAssistant.ts /
// rutaTools.ts / crmTools.ts / analyticsTools.ts / insights/*), which is
// what every WhatsApp inbound message actually runs through today. This
// file predates that build, was never wired into any webhook handler or
// API route (confirmed: no import of this module exists anywhere else in
// the codebase), and was left in the tree by mistake rather than deleted.
//
// It broke `npm run build` because it referenced a stale permission key
// (`WHATSAPP_BOT_BROAD_QUERY`) that was renamed to
// `RUTA_AI_ASSISTANT_BROAD_QUERY` during the real build - see
// `claude/whatsapp-internal-query-bot-flow.md` (CRM Automation project)
// for the full history.
//
// Stubbed to an empty, comment-only file (rather than left broken) so the
// build stays green - safe to delete this file entirely whenever
// convenient; nothing references it.
//
// See also: public/settings/whatsapp-bot.html - the other orphaned file
// from this same superseded first draft, also safe to delete.
export {};
