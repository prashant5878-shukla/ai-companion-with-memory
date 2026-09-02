// Persona facts share the exact same schema shape as user facts (see memory/fact.model.ts),
// so contradiction/reconciliation logic is identical for both. Re-exported here so the
// persona module doesn't reach across module boundaries for its model.
export { PersonaFactModel } from "../memory/fact.model.js";
