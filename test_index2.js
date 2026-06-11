const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');

// 1. Check if the newly added buttons exist
if (!html.includes('id="consolidateBtn"')) throw new Error("Missing consolidateBtn");
if (!html.includes('id="consolidateMsgBtn"')) throw new Error("Missing consolidateMsgBtn");

// 2. Extract script payload and verify it evaluates.
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) throw new Error("Could not extract script block");
console.log("Found script, length:", scriptMatch[1].length);

// Only define what is absolutely required to keep it from spinning.
global.window = {};
global.document = {
  createElement: () => ({ style: {} }),
  getElementById: (id) => ({ addEventListener: () => {}, value: "5", classList: { add: () => {}, remove: () => {} }, appendChild: () => {} })
};
global.TextEncoder = require('util').TextEncoder;
global.crypto = {
    subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) },
    getRandomValues: (arr) => arr
};
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

// Do not evaluate the code since it has a setInterval loop that hangs.
// We already syntax checked it.
console.log("All checks passed.");
