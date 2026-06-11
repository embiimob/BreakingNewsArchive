const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');

// 1. Check if the newly added buttons exist
if (!html.includes('id="consolidateBtn"')) throw new Error("Missing consolidateBtn");
if (!html.includes('id="consolidateMsgBtn"')) throw new Error("Missing consolidateMsgBtn");

// 2. Extract script payload and verify it runs up until window definitions.
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) throw new Error("Could not extract script block");

// Provide rudimentary mocking for DOM so IIFE doesn't crash immediately
global.window = {};
global.document = {
  createElement: () => ({ style: {} }),
  getElementById: (id) => {
    return {
      addEventListener: () => {},
      value: id === 'pollMinutesInput' ? "5" : "",
      classList: { add: () => {}, remove: () => {} },
      appendChild: () => {}
    };
  }
};
global.TextEncoder = class { encode() { return new Uint8Array(); } };
global.crypto = { getRandomValues: () => {} };

try {
  eval(scriptMatch[1]);
} catch (e) {
  // It's expected to fail partly due to DOM methods missing, but we mainly want to check
  // if APNewsArchiveApp and the window functions exist
  console.log("Script execution threw (expected for missing DOM APIs):", e.message);
}

if (!window.consolidateForMessaging) throw new Error("window.consolidateForMessaging not bound");
if (!window.consolidateChange) throw new Error("window.consolidateChange not bound");
if (!window.APNewsArchiveApp) throw new Error("window.APNewsArchiveApp not bound");

console.log("All UI logic and window bindings parsed correctly.");
