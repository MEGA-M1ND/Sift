/**
 * Settings page. Minimal for now: the API key has to be enterable before the
 * panel can do anything. Fleshed out in phase 5.
 */
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../shared/settings.js";

async function main(): Promise<void> {
  const app = document.querySelector("#app")!;
  const settings = await loadSettings();

  app.innerHTML = `
    <h1>Sift</h1>
    <label>TypeSafe API key<br><input id="key" type="password" size="52"></label>
    <p><button id="save">Save</button> <span id="status"></span></p>
  `;

  const key = app.querySelector<HTMLInputElement>("#key")!;
  key.value = settings.apiKey;

  app.querySelector("#save")!.addEventListener("click", () => {
    void saveSettings({ ...DEFAULT_SETTINGS, ...settings, apiKey: key.value.trim() }).then(() => {
      app.querySelector("#status")!.textContent = "Saved.";
    });
  });
}

void main();
