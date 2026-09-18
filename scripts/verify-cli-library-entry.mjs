import { verifyCliLibrary } from './verify-cli-library.mjs';

process.stdout.write(`${JSON.stringify(await verifyCliLibrary(), null, 2)}\n`);
