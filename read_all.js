const fs = require('fs');
const diff = fs.readFileSync('pr36.diff', 'utf8');
const p1 = diff.indexOf('async function consolidateForMessagingFunds');
const p2 = diff.indexOf('async function consolidateChangeFunds');
const p3 = diff.indexOf('function normalizeProfile');
console.log('--- consolidateForMessagingFunds ---');
console.log(diff.substring(p1, p2));
console.log('--- consolidateChangeFunds ---');
console.log(diff.substring(p2, p3));
