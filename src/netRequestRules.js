/* globals chrome */
import globMatchToDNRRegex from "./globMatchToDNRRegex.js";
import extractMimeType from "./extractMime.js";
import { parseHeaderDataStr } from "./util.js";

export const allResourceTypes = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
"xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"];

export const transformMatchReplace = (match = "", replace = "") => {
    const trimMatch = match.trim();
    if (trimMatch.length > 2 && trimMatch[0] === "/" && trimMatch[trimMatch.length - 1] === "/") {
        // the match string has the "regex mode" characters, so dont do transform.
        return {
            match: trimMatch.substring(1, trimMatch.length - 1),
            replace
        };
    }
    const result = globMatchToDNRRegex(match, replace);
    result.match = `^${result.match}$`;
    return result;
};

// Builds the dynamic rule for a single rule, or null when the rule produces nothing.
const buildDnrRule = (rule, priority) => {
    if (rule.type === "normalOverride" && rule.match && rule.replace) {
        const transformedMatchReplace = transformMatchReplace(rule.match, rule.replace);
        return {
            id: rule.id,
            priority,
            action: {
                type: "redirect",
                redirect: {
                    regexSubstitution: transformedMatchReplace.replace
                }
            },
            condition: {
                resourceTypes: allResourceTypes,
                regexFilter: transformedMatchReplace.match
            }
        };
    } else if (rule.type === "fileOverride" && rule.match) {
        const mimeAndFile = extractMimeType(rule.match, rule.file);
        const transformedMatchReplace = transformMatchReplace(rule.match, "");
        return {
            id: rule.id,
            priority,
            action: {
                type: "redirect",
                redirect: {
                    url: "data:" + mimeAndFile.mime + ";charset=UTF-8;base64," +
                    btoa(unescape(encodeURIComponent(mimeAndFile.file || "")))
                }
            },
            condition: {
                resourceTypes: allResourceTypes,
                regexFilter: transformedMatchReplace.match
            }
        };
    } else if (rule.type === "headerRule" && rule.match) {
        const transformedMatchReplace = transformMatchReplace(rule.match, "");
        const requestHeaders = parseHeaderDataStr(rule.requestRules || "");
        const responseHeaders = parseHeaderDataStr(rule.responseRules || "");
        const action = { type: "modifyHeaders" };
        if (requestHeaders.length) {
            action.requestHeaders = requestHeaders;
        }
        if (responseHeaders.length) {
            action.responseHeaders = responseHeaders;
        }
        if (action.requestHeaders || action.responseHeaders) {
            return {
                id: rule.id,
                priority,
                action,
                condition: {
                    resourceTypes: allResourceTypes,
                    regexFilter: transformedMatchReplace.match
                }
            };
        }
    }
    return null;
};

// Turns one rule group into the dynamic rules it should register. Free of chrome API
// calls so callers can batch every group into a single round trip.
export const buildGroupNetRequestRules = (group = {}, ruleErrors = {}) => {
    const rules = group.rules || [];
    const ruleIds = rules.map(rule => rule.id);
    const dnrRules = [];
    if (group.on) {
        rules.forEach((rule, idx) => {
            if (rule.on && !ruleErrors[rule.id]) {
                const dnrRule = buildDnrRule(rule, 10 + rules.length - idx);
                if (dnrRule) {
                    dnrRules.push(dnrRule);
                }
            }
        });
    }
    return { ruleIds, dnrRules };
};

// Turns a declarativeNetRequest rejection into a message the user can act on.
const errorMessageForRule = (rule, errorMessage) => {
    if (errorMessage.includes("regexSubstitution")) {
        return "The \"To\" field has incorrect syntax or is referencing an undefined capture group.";
    }
    if (errorMessage.includes("regexFilter")) {
        return rule && rule.type === "headerRule"
            ? "The \"For\" field has incorrect syntax."
            : "The \"From\" field has incorrect syntax.";
    }
    return errorMessage;
};

// Chrome reports which rule was rejected as part of the error message.
const parseBadRuleId = (e) => {
    const messageParts = e.message?.split?.("Rule with id ");
    if (messageParts && messageParts.length > 1) {
        const badId = parseInt(messageParts[1]);
        if (!isNaN(badId)) {
            return badId;
        }
    }
    return null;
};

// Rules Chrome refuses to register are recorded in ruleErrors, keyed by rule id,
// so the UI can highlight them and explain why.
const flagRule = (ruleErrors, ruleId, message) => {
    if (!ruleErrors[ruleId]) {
        ruleErrors[ruleId] = message;
    }
};

// Flags every rule in a group that should have been registered but was not. Used
// when a whole call is refused: rules that are switched off, or that produce no
// dynamic rule in the first place, are left alone.
const flagUnappliedRules = (group, ruleErrors, message) => {
    const { dnrRules } = buildGroupNetRequestRules(group, ruleErrors);
    dnrRules.forEach(rule => flagRule(ruleErrors, rule.id, message));
};

// Chrome rejects a whole call once the dynamic regex rule ceiling is exceeded.
// The raw message is accurate but terse, so spell the limit out when it matches.
const wholeCallErrorMessage = (error) => {
    if (typeof error?.message === "string" && (/regex rules exceeded/i).test(error.message)) {
        const max = chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES;
        return `Not applied: this rule set needs more than the ${max} dynamic regex rules Chrome allows.`;
    }
    return `Not applied: ${error?.message || "Chrome rejected this rule set."}`;
};

// Applies one group's rules. A single invalid regex fails the whole call, so the
// offending rule is flagged and the call retried without it. Resolves to null once
// the group is applied, or to the rejection error when the failure is not tied to
// an individual rule - which means retrying cannot help.
const applyGroupRules = async (group, deletedRuleIds, ruleErrors) => {
    for (;;) {
        const { ruleIds, dnrRules } = buildGroupNetRequestRules(group, ruleErrors);
        const ruleIdToRule = {};
        (group.rules || []).forEach(rule => {
            ruleIdToRule[rule.id] = rule;
        });
        try {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: ruleIds.concat(deletedRuleIds),
                addRules: dnrRules
            });
            return null;
        } catch (e) {
            console.error("FAILED TO UPDATE RULES!", e);
            const badId = parseBadRuleId(e);
            const badRule = badId === null ? null : ruleIdToRule[badId];
            // An unknown or already flagged rule cannot be resolved by retrying.
            if (!badRule || ruleErrors[badId]) {
                return e;
            }
            flagRule(ruleErrors, badId, errorMessageForRule(badRule, e.message));
        }
    }
};

const setupNetRequestRules = async (group = {}, deletedRuleIds = [], ruleErrors = {}) => {
    const error = await applyGroupRules(group, deletedRuleIds, ruleErrors);
    if (error) {
        // The group as a whole was refused. Flag it rather than failing silently.
        flagUnappliedRules(group, ruleErrors, wholeCallErrorMessage(error));
    }
    return ruleErrors;
};

// Applies the groups one at a time. Chrome refuses a call that would push past the
// dynamic regex rule ceiling, so batching a large rule set used to leave the user
// with no rules at all and no explanation. Group by group keeps everything that
// fits, and flags the rest with the reason.
const applyGroupsIndividually = async (groups, ruleErrorsByGroup, removeRuleIds) => {
    // The refused batch left the previous rules in place, but this path is meant to
    // register exactly the given groups, so start from a clean slate.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });

    let refused = null;
    for (const group of groups) {
        const ruleErrors = ruleErrorsByGroup[group.id] || (ruleErrorsByGroup[group.id] = {});
        if (refused) {
            // The ceiling is reached cumulatively, so later groups cannot fit either.
            flagUnappliedRules(group, ruleErrors, wholeCallErrorMessage(refused));
            continue;
        }
        const error = await applyGroupRules(group, [], ruleErrors);
        if (error) {
            refused = error;
            flagUnappliedRules(group, ruleErrors, wholeCallErrorMessage(error));
        }
    }
    return ruleErrorsByGroup;
};

// Applies every group with a single declarativeNetRequest round trip. Doing this per
// group made importing a large rule set slow, since each group cost an API call.
export const setupAllNetRequestRules = async (groups = [], ruleErrorsByGroup = {}) => {
    // One bad regex fails the whole batch, so flag the offending rule and retry.
    for (;;) {
        const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
        const removeRuleIds = existingRules.map(rule => rule.id);
        const addRules = [];
        const ruleIdToGroup = {};
        groups.forEach(group => {
            const ruleErrors = ruleErrorsByGroup[group.id] || (ruleErrorsByGroup[group.id] = {});
            const { dnrRules } = buildGroupNetRequestRules(group, ruleErrors);
            (group.rules || []).forEach(rule => {
                ruleIdToGroup[rule.id] = { group, rule };
            });
            addRules.push(...dnrRules);
        });
        try {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
            return ruleErrorsByGroup;
        } catch (e) {
            console.error("FAILED TO UPDATE RULES!", e);
            const badId = parseBadRuleId(e);
            const badRuleInfo = badId === null ? null : ruleIdToGroup[badId];
            if (!badRuleInfo) {
                // Not tied to a single rule: the batch was refused as a whole, usually
                // because it exceeds the regex rule ceiling. Apply what fits instead of
                // leaving the extension with no rules and no explanation.
                return applyGroupsIndividually(groups, ruleErrorsByGroup, removeRuleIds);
            }
            const groupErrors = ruleErrorsByGroup[badRuleInfo.group.id] ||
                (ruleErrorsByGroup[badRuleInfo.group.id] = {});
            groupErrors[badId] = errorMessageForRule(badRuleInfo.rule, e.message);
        }
    }
};

// Number of rules that could not be registered, so callers can tell a complete
// import from a partial one.
export const countRuleErrors = (ruleErrorsByGroup = {}) =>
    Object.values(ruleErrorsByGroup).reduce(
        (total, groupErrors) => total + Object.keys(groupErrors).length,
        0
    );

// Removes every dynamic rule this extension has registered. Used by the
// "clear all rules" action, which must not leave stale rules behind.
export const clearAllNetRequestRules = async () => {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules.map(rule => rule.id);
    if (removeRuleIds.length) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    }
};

export default setupNetRequestRules;
