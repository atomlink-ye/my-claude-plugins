#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'heartbeat' && args[1] === 'delete') {
  process.stderr.write('schedule not found');
  process.exit(1);
}
process.stdout.write('{}');
