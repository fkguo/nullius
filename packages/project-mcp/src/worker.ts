import { writeJsonAtomicDurable } from '@nullius/shared';
import { readRequest } from './delivery.js';
import { execute } from './execute.js';
import { errorResult } from './result.js';

const filename = process.argv[2]!;
const request = readRequest(filename);
process.chdir(request.root);
const result = await execute(request.root, request.name, request.args).catch(errorResult);
// Only the supervisor commits, after the process has exited and relinquished the project.
writeJsonAtomicDurable(`${filename}.response`, result);
