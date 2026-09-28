// Run with: node test/netRequestRulesTest.js
import "./fakeChrome.js";
import { resetDnr, getDynamicRules } from "./fakeChrome.js";
import { buildGroupNetRequestRules, setupAllNetRequestRules } from "../src/netRequestRules.js";

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message} (${JSON.stringify(actual)}) !== (${JSON.stringify(expected)})`);
    }
}

function makeGroup(id, rules, on = true) {
    return { id, name: `group${id}`, on, rules };
}

const groups = [
    makeGroup(1, [
        { id: 1, type: "normalOverride", match: "a.com/x.js", replace: "a.com/y.js", on: true },
        { id: 2, type: "normalOverride", match: "a.com/p.js", replace: "a.com/q.js", on: false }
    ]),
    makeGroup(2, [
        { id: 3, type: "normalOverride", match: "b.com/x.js", replace: "b.com/y.js", on: true }
    ]),
    makeGroup(3, [
        { id: 4, type: "normalOverride", match: "c.com/x.js", replace: "c.com/y.js", on: true }
    ], false)
];

// --- building a group is pure and skips disabled rules and disabled groups ---
const built = buildGroupNetRequestRules(groups[0]);
assertEqual(built.ruleIds.length, 2, "Should report both rule ids for removal");
assertEqual(built.dnrRules.length, 1, "Only the enabled rule should be built");
assertEqual(buildGroupNetRequestRules(groups[2]).dnrRules.length, 0, "A disabled group builds nothing");
assertEqual(buildGroupNetRequestRules(groups[2]).ruleIds.length, 1, "A disabled group still reports its ids");

// --- a rule already flagged as an error is left out ---
const errored = buildGroupNetRequestRules(groups[1], { 3: "bad regex" });
assertEqual(errored.dnrRules.length, 0, "Rules with a known error should not be retried");

// --- applying many groups costs exactly one API call ---
resetDnr([]);
const errors = await setupAllNetRequestRules(groups);
assertEqual(
    globalThis.__updateDynamicRulesCalls,
    1,
    "Applying three groups must not cost three API calls"
);
assertEqual(getDynamicRules().length, 2, "The two enabled rules across enabled groups should be applied");
const errorCount = Object.values(errors).reduce((sum, groupErrors) => sum + Object.keys(groupErrors).length, 0);
assertEqual(errorCount, 0, "No errors should be reported for valid rules");

// --- re-applying replaces the previous set instead of duplicating it ---
await setupAllNetRequestRules(groups);
assertEqual(getDynamicRules().length, 2, "Re-applying must not duplicate rules");
assertEqual(
    globalThis.__updateDynamicRulesCalls,
    2,
    "Two apply passes should cost two API calls total"
);
assertEqual(
    globalThis.__addedDnrRules.length,
    4,
    "Each apply pass should submit both enabled rules"
);

// --- applying an empty rule set clears everything ---
await setupAllNetRequestRules([]);
assertEqual(getDynamicRules().length, 0, "Applying no groups should leave no dynamic rules");

// --- a rejected batch is retried with the offending rule flagged ---
const goodGroup = makeGroup(9, [
    { id: 90, type: "normalOverride", match: "ok.com/a.js", replace: "ok.com/b.js", on: true }
]);
const badGroup = makeGroup(10, [
    { id: 91, type: "normalOverride", match: "bad.com/a.js", replace: "bad.com/b.js", on: true }
]);
resetDnr([]);
const realUpdate = globalThis.chrome.declarativeNetRequest.updateDynamicRules;
const realConsoleError = console.error;
// The module logs the rejection on purpose; keep the test output readable.
console.error = () => {};
globalThis.chrome.declarativeNetRequest.updateDynamicRules = async (opts) => {
    if ((opts.addRules || []).some(rule => rule.id === 91)) {
        throw new Error("Rule with id 91 has an error in regexFilter");
    }
    return realUpdate(opts);
};
const retryErrors = await setupAllNetRequestRules([goodGroup, badGroup]);
globalThis.chrome.declarativeNetRequest.updateDynamicRules = realUpdate;
console.error = realConsoleError;

assert(
    retryErrors[10] && retryErrors[10][91],
    "The offending rule should be reported under its group"
);
const healthyGroupErrors = retryErrors[9] || {};
assertEqual(Object.keys(healthyGroupErrors).length, 0, "The healthy group should have no errors");
assertEqual(getDynamicRules().length, 1, "The healthy rule should still be applied");
assertEqual(getDynamicRules()[0].id, 90, "The surviving rule should be the healthy one");

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

console.log("All netRequestRules tests succeeded!");