// Imports the settings Chrome policy gives this extension. moonpie writes them
// from a plain JSON file: settingsJson holds the chrome.storage.local items to
// set, and settingsSha256 names that version. Each version is written once,
// so a change made in the browser lasts until the policy changes.
const APPLIED_KEY = "managedSettingsSha256";

async function importManagedSettings() {
  const { settingsJson, settingsSha256 } = await chrome.storage.managed.get([
    "settingsJson",
    "settingsSha256",
  ]);
  if (typeof settingsJson !== "string" || typeof settingsSha256 !== "string") return;
  const { [APPLIED_KEY]: applied } = await chrome.storage.local.get(APPLIED_KEY);
  if (applied === settingsSha256) return;
  await chrome.storage.local.set({
    ...JSON.parse(settingsJson),
    [APPLIED_KEY]: settingsSha256,
  });
}

// Call once, synchronously at startup, so a policy change wakes the worker.
// `ready` is the extension's own startup, which may write storage: the import
// waits for it, so that startup cannot overwrite the imported settings.
export function watchManagedSettings(ready = Promise.resolve()) {
  const run = () =>
    Promise.allSettled([ready])
      .then(importManagedSettings)
      .catch((error) => console.error("Could not import the managed settings:", error));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "managed") run();
  });
  run();
}
