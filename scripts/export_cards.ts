// Exports the typed cards to cards.json (used by the Lambda package, the audio
// script, and the static site). Run: npx vite-node scripts/export_cards.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { CARDS } from "../src/cards";
import { validateCards } from "../src/validate";

const issues = validateCards(CARDS);
if (issues.length) {
  console.error("Refusing to export: content validation failed", issues);
  process.exit(1);
}

mkdirSync("public", { recursive: true });
const json = JSON.stringify(CARDS, null, 2) + "\n";
writeFileSync("cards.json", json);        // Lambda package + audio script input
writeFileSync("public/cards.json", json); // served by the site
console.log(`exported ${CARDS.length} cards`);
