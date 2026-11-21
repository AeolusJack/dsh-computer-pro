import { fileURLToPath } from 'node:url';
import { verifyPayload } from '../src/payload.js';
console.log(JSON.stringify(await verifyPayload(fileURLToPath(new URL('../', import.meta.url))), null, 2));
