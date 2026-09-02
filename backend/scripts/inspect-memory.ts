import { Database } from "../src/config/database.js";
import { FactModel, PersonaFactModel } from "../src/modules/memory/fact.model.js";

function formatFact(f: any): string {
  const flag = f.status === "superseded" ? "✗ superseded" : "✓ active";
  return `  [${flag}] (${f.category}) ${f.subject}.${f.predicate} = "${f.object}"  (conf ${f.confidence.toFixed(2)}, id ${f._id})${
    f.supersededBy ? ` -> superseded by ${f.supersededBy}` : ""
  }`;
}

async function main() {
  await Database.connect();

  const userFacts = await FactModel.find({}).sort({ createdAt: 1 }).lean();
  const personaFacts = await PersonaFactModel.find({}).sort({ createdAt: 1 }).lean();

  console.log(`\n=== User facts (${userFacts.length}) ===`);
  for (const f of userFacts) console.log(formatFact(f));

  console.log(`\n=== Persona facts (${personaFacts.length}) ===`);
  for (const f of personaFacts) console.log(formatFact(f));

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
