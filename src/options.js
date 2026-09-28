import { exportData, importData } from "./importExport.js";
import {
    getUiElements,
    showToast,
} from "./util.js";

/* global chrome */

export const updateOptions = async () => {
    const options = await chrome.storage.local.get({ optionDevTools: true });
    document.getElementById("showDevTools").checked = options.optionDevTools;
};

// onRulesChanged is called after the stored rules were replaced from the outside
// (import or clear all), so the caller can re-render and re-apply the DNR rules.
const initOptions = (onRulesChanged) => {
    const ui = getUiElements(document);

    window.addEventListener("click", (e) => {
        const target = e.target;
        if (target.id === "optionsBtn") {
            ui.optionsPopOver.style.display = ui.optionsPopOver.style.display === "block" ? "none" : "block";
            ui.helpOverlay.style.display = "none";
        } else {
            if (!target.closest("#optionsPopOver")) {
                ui.optionsPopOver.style.display = "none";
            }
        }
    });

    ui.showDevTools.addEventListener("click", async () => {
        chrome.storage.local.set({
            optionDevTools: ui.showDevTools.checked,
        });
    });

    ui.saveRulesLink.addEventListener("click", async (e) => {
        e.preventDefault();
        const data = await exportData();
        const json = JSON.stringify(data);
        const blob = new Blob([json], {type: "text/plain"});
        const downloadLink = document.createElement("a");
        downloadLink.download = "resource_override_rules.json";
        downloadLink.href = window.URL.createObjectURL(blob);
        downloadLink.click();
        ui.optionsPopOver.style.display = "none";
    });


    ui.loadRulesLink.addEventListener("click", (e) => {
        e.preventDefault();
        ui.loadRulesInput.click();
        ui.optionsPopOver.style.display = "none";
    });

    ui.loadRulesInput.addEventListener("change", () => {
        const reader = new FileReader();
        reader.onload = async function() {
            const text = reader.result;
            let importedObj;
            try {
                importedObj = JSON.parse(text);
            } catch (e) {
                showToast("Load Failed: Invalid JSON in file.");
                return;
            }
            // "data" is the historical key; older v1 exports also used it.
            const importedData = importedObj.data !== undefined ? importedObj.data : importedObj.ruleGroups;
            const imported = await importData(importedData, importedObj.v);
            if (imported && onRulesChanged) {
                await onRulesChanged();
            }
        };
        reader.readAsText(ui.loadRulesInput.files[0]);
        ui.loadRulesInput.value = "";
    });
};

export default initOptions;
