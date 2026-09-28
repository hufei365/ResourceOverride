// Minimal chrome/DOM stubs so the import/export logic can run outside a browser.
// Import this module before the modules under test so that the globals exist
// by the time they are evaluated.

const store = {};

const fakeElement = {
    innerHTML: "",
    textContent: "",
    value: "",
    style: {},
    classList: {
        add() {},
        remove() {},
        contains() {
            return false;
        }
    },
    setAttribute() {},
    removeAttribute() {},
    querySelectorAll() {
        return [];
    }
};

if (!globalThis.document) {
    globalThis.document = {
        querySelector: () => fakeElement,
        querySelectorAll: () => [],
        getElementById: () => fakeElement,
        createElement: () => fakeElement,
        importNode: () => fakeElement
    };
}

globalThis.chrome = {
    storage: {
        local: {
            get: async (keys) => {
                // A null/undefined key list means "everything", matching the real API.
                if (keys === null || keys === undefined) {
                    return { ...store };
                }
                const ans = {};
                if (Array.isArray(keys)) {
                    keys.forEach(key => {
                        if (key in store) {
                            ans[key] = store[key];
                        }
                    });
                } else {
                    Object.keys(keys || {}).forEach(key => {
                        ans[key] = key in store ? store[key] : keys[key];
                    });
                }
                return ans;
            },
            set: async (data) => {
                Object.assign(store, data);
            },
            remove: async (keys) => {
                (Array.isArray(keys) ? keys : [keys]).forEach(key => delete store[key]);
            }
        }
    },
    runtime: {
        sendMessage: async () => {}
    }
};

// Records every declarativeNetRequest mutation so tests can assert on them.
globalThis.__removedDnrRuleIds = [];
globalThis.__addedDnrRules = [];
globalThis.__updateDynamicRulesCalls = 0;

let dynamicRules = [];

globalThis.chrome.declarativeNetRequest = {
    getDynamicRules: async () => dynamicRules.slice(),
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
        globalThis.__updateDynamicRulesCalls++;
        globalThis.__removedDnrRuleIds.push(...removeRuleIds);
        globalThis.__addedDnrRules.push(...addRules);
        const removeSet = new Set(removeRuleIds);
        dynamicRules = dynamicRules.filter(rule => !removeSet.has(rule.id));
        dynamicRules.push(...addRules);
        return undefined;
    }
};

export const resetDnr = (rules = []) => {
    dynamicRules = rules.slice();
    globalThis.__removedDnrRuleIds = [];
    globalThis.__addedDnrRules = [];
    globalThis.__updateDynamicRulesCalls = 0;
};

export const getDynamicRules = () => dynamicRules.slice();

export const resetStore = (data = {}) => {
    Object.keys(store).forEach(key => delete store[key]);
    Object.assign(store, data);
};

export const getStore = () => store;
