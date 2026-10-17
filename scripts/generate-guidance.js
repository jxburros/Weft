import { writeFileSync } from 'node:fs';
import { renderGuidance } from '../src/guidance.js';
writeFileSync(new URL('../skills/weft/references/guidance.md', import.meta.url), renderGuidance());
