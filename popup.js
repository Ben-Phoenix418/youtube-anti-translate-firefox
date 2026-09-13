// Popup toggle for Anti-translate for YouTube.
const api = globalThis.browser ?? globalThis.chrome;
const checkbox = document.getElementById("enabled");

async function load() {
  try {
    const { enabled = true } = await api.storage.local.get("enabled");
    checkbox.checked = enabled !== false;
  } catch {
    checkbox.checked = true;
  }
}

checkbox.addEventListener("change", async () => {
  try {
    await api.storage.local.set({ enabled: checkbox.checked });
  } catch {
    // storage unavailable; content script stays at default (enabled)
  }
});

load();
