import {
  availableFontChoices,
  clampFontSize,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  type AppearancePrefs,
} from "./appearance";

interface SettingsPanelOptions {
  initial: AppearancePrefs;
  platform: string | undefined;
  focusFallback: HTMLElement;
  onChange(prefs: AppearancePrefs): void;
}

interface SettingsPanel {
  open(): void;
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function initSettingsPanel(opts: SettingsPanelOptions): SettingsPanel {
  const settingsModal = byId<HTMLDivElement>("settings-modal");
  const settingsCloseBtn = byId<HTMLButtonElement>("settings-close");
  const settingsViewMode = byId<HTMLSelectElement>("settings-view-mode");
  const settingsFontSize = byId<HTMLInputElement>("settings-font-size");
  const settingsFontSizeValue = byId<HTMLInputElement>(
    "settings-font-size-value",
  );
  const settingsFontFamily = byId<HTMLSelectElement>("settings-font-family");
  const settingsFontFamilyNote = byId<HTMLDivElement>(
    "settings-font-family-note",
  );
  const settingsCustomFont = byId<HTMLInputElement>("settings-custom-font");
  const settingsResetBtn = byId<HTMLButtonElement>("settings-reset");

  let appearance = normalizeAppearance(opts.initial);
  let fontSizeInputTimer: number | null = null;

  async function syncFontChoicesUi(selected: string): Promise<void> {
    const choices = await availableFontChoices();
    settingsFontFamily.innerHTML = "";
    for (const choice of choices) {
      const option = document.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      settingsFontFamily.appendChild(option);
    }

    const isKnownChoice = choices.some((choice) => choice.value === selected);
    if (selected !== "system" && !isKnownChoice) {
      const customOption = document.createElement("option");
      customOption.value = "custom";
      customOption.textContent = "Custom local font";
      settingsFontFamily.appendChild(customOption);
      settingsFontFamily.value = "custom";
      settingsCustomFont.value = selected;
    } else {
      settingsFontFamily.value = selected;
      settingsCustomFont.value = "";
    }

    const installed = Math.max(0, choices.length - 1);
    settingsFontFamilyNote.textContent =
      installed > 0
        ? `${installed} installed monospace font families detected on this machine.`
        : "No local monospace fonts were exposed by the system. You can still type a local font name below.";
  }

  function syncSettingsUi(prefs: AppearancePrefs): void {
    settingsViewMode.value = prefs.viewMode;
    settingsFontSize.value = String(prefs.fontSize);
    settingsFontSizeValue.value = String(prefs.fontSize);
    void syncFontChoicesUi(prefs.fontFamily);
  }

  function applyAppearancePrefs(next: AppearancePrefs): void {
    appearance = normalizeAppearance(next);
    syncSettingsUi(appearance);
    opts.onChange(appearance);
  }

  function scheduleFontSizeApply(raw: string, syncControls: boolean): void {
    const parsed = Number(raw);
    if (fontSizeInputTimer !== null) {
      window.clearTimeout(fontSizeInputTimer);
      fontSizeInputTimer = null;
    }
    if (!Number.isFinite(parsed) || parsed < 11 || parsed > 24) return;
    const fontSize = clampFontSize(parsed);
    if (syncControls) {
      settingsFontSize.value = String(fontSize);
      settingsFontSizeValue.value = String(fontSize);
    } else {
      settingsFontSize.value = String(fontSize);
    }
    fontSizeInputTimer = window.setTimeout(() => {
      fontSizeInputTimer = null;
      applyAppearancePrefs({
        ...appearance,
        fontSize,
      });
    }, 120);
  }

  function flushFontSizeApply(raw: string): void {
    if (fontSizeInputTimer !== null) {
      window.clearTimeout(fontSizeInputTimer);
      fontSizeInputTimer = null;
    }
    applyAppearancePrefs({
      ...appearance,
      fontSize: Number(raw),
    });
  }

  function open(): void {
    syncSettingsUi(appearance);
    settingsModal.hidden = false;
    settingsViewMode.focus();
  }

  function close(): void {
    settingsModal.hidden = true;
    opts.focusFallback.focus();
  }

  settingsCloseBtn.addEventListener("click", () => close());
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) close();
  });
  settingsViewMode.addEventListener("change", () => {
    applyAppearancePrefs({
      ...appearance,
      viewMode: normalizeAppearance({
        ...appearance,
        viewMode: settingsViewMode.value,
      }).viewMode,
    });
  });
  settingsFontSize.addEventListener("input", () => {
    scheduleFontSizeApply(settingsFontSize.value, true);
  });
  settingsFontSize.addEventListener("change", () => {
    flushFontSizeApply(settingsFontSize.value);
  });
  settingsFontSizeValue.addEventListener("input", () => {
    scheduleFontSizeApply(settingsFontSizeValue.value, false);
  });
  settingsFontSizeValue.addEventListener("change", () => {
    flushFontSizeApply(settingsFontSizeValue.value);
  });
  settingsFontFamily.addEventListener("change", () => {
    if (settingsFontFamily.value === "custom") {
      settingsCustomFont.focus();
      return;
    }
    applyAppearancePrefs({
      ...appearance,
      fontFamily: settingsFontFamily.value,
    });
  });
  settingsCustomFont.addEventListener("change", () => {
    const next = settingsCustomFont.value.trim();
    if (!next) {
      applyAppearancePrefs({
        ...appearance,
        fontFamily: "system",
      });
      return;
    }
    applyAppearancePrefs({
      ...appearance,
      fontFamily: next,
    });
  });
  settingsResetBtn.addEventListener("click", () => {
    applyAppearancePrefs({ ...DEFAULT_APPEARANCE });
  });
  window.addEventListener(
    "keydown",
    (e) => {
      const isMac = opts.platform === "darwin";
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (
        mod &&
        !e.altKey &&
        !e.shiftKey &&
        e.code === "Comma" &&
        (isMac || !e.metaKey)
      ) {
        e.preventDefault();
        open();
        return;
      }
      if (e.key === "Escape" && !settingsModal.hidden) {
        e.preventDefault();
        close();
      }
    },
    true,
  );

  return { open };
}
