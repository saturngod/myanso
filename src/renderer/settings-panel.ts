import {
  availableFontChoices,
  buildTerminalFontFamily,
  clampFontSize,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  VIEW_MODE_LINE_HEIGHT,
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
  const settingsCustomFontRow = byId<HTMLDivElement>(
    "settings-custom-font-row",
  );
  const settingsCustomFont = byId<HTMLInputElement>("settings-custom-font");
  const settingsResetBtn = byId<HTMLButtonElement>("settings-reset");
  const settingsApplyBtn = byId<HTMLButtonElement>("settings-apply");
  const settingsPreview = byId<HTMLDivElement>("settings-preview");

  let lastApplied = normalizeAppearance(opts.initial);
  let pending = { ...lastApplied };
  let fontSizeInputTimer: number | null = null;
  let closing = false;
  let cachedChoices: Array<{ value: string; label: string }> | null = null;
  let lastChoicesSnapshot: string | null = null;

  function prefsEqual(a: AppearancePrefs, b: AppearancePrefs): boolean {
    return (
      a.viewMode === b.viewMode &&
      a.fontSize === b.fontSize &&
      a.fontFamily === b.fontFamily
    );
  }

  function syncApplyButton(): void {
    settingsApplyBtn.disabled = prefsEqual(pending, lastApplied);
  }

  async function getFontChoices(): Promise<
    Array<{ value: string; label: string }>
  > {
    if (cachedChoices) return cachedChoices;
    cachedChoices = await availableFontChoices();
    return cachedChoices;
  }

  async function syncFontChoicesUi(selected: string): Promise<void> {
    const choices = await getFontChoices();
    const snapshot = choices.map((c) => c.value).join(",");

    if (snapshot !== lastChoicesSnapshot) {
      settingsFontFamily.innerHTML = "";
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        settingsFontFamily.appendChild(option);
      }
      const customOption = document.createElement("option");
      customOption.value = "custom";
      customOption.textContent = "Custom local font";
      settingsFontFamily.appendChild(customOption);
      lastChoicesSnapshot = snapshot;
    }

    const isKnownChoice = choices.some((choice) => choice.value === selected);
    if (selected !== "system" && !isKnownChoice) {
      settingsFontFamily.value = "custom";
      settingsCustomFont.value = selected;
    } else {
      settingsFontFamily.value = selected;
      settingsCustomFont.value = "";
    }

    toggleCustomFontRow(selected !== "system" && !isKnownChoice);

    const installed = Math.max(0, choices.length - 1);
    settingsFontFamilyNote.textContent =
      installed > 0
        ? `${installed} installed monospace font families detected on this machine.`
        : "No local monospace fonts were exposed by the system. You can still type a local font name below.";
  }

  function toggleCustomFontRow(show: boolean): void {
    settingsCustomFontRow.hidden = !show;
  }

  function updatePreview(prefs: AppearancePrefs): void {
    const fontFamily = buildTerminalFontFamily(prefs.fontFamily);
    settingsPreview.style.setProperty("--preview-font", fontFamily);
    settingsPreview.style.setProperty("--preview-size", `${prefs.fontSize}px`);
    settingsPreview.style.lineHeight = String(VIEW_MODE_LINE_HEIGHT[prefs.viewMode]);
  }

  function syncControlsFromPrefs(prefs: AppearancePrefs): void {
    settingsViewMode.value = prefs.viewMode;
    settingsFontSize.value = String(prefs.fontSize);
    settingsFontSizeValue.value = String(prefs.fontSize);
  }

  /** Update pending state, sync controls + preview, enable Apply if dirty. */
  function markDirty(next: AppearancePrefs): void {
    pending = normalizeAppearance(next);
    syncControlsFromPrefs(pending);
    updatePreview(pending);
    syncApplyButton();
  }

  /** Commit pending → lastApplied, save + apply to all tabs. */
  function applyPending(): void {
    lastApplied = { ...pending };
    opts.onChange(lastApplied);
    syncApplyButton();
  }

  function setFontSize(rawValue: string): void {
    if (fontSizeInputTimer !== null) {
      window.clearTimeout(fontSizeInputTimer);
      fontSizeInputTimer = null;
    }
    const fontSize = clampFontSize(Number(rawValue));
    settingsFontSize.value = String(fontSize);
    settingsFontSizeValue.value = String(fontSize);
    fontSizeInputTimer = window.setTimeout(() => {
      fontSizeInputTimer = null;
      markDirty({ ...pending, fontSize });
    }, 120);
  }

  function flushFontSize(rawValue: string): void {
    if (fontSizeInputTimer !== null) {
      window.clearTimeout(fontSizeInputTimer);
      fontSizeInputTimer = null;
    }
    const fontSize = clampFontSize(Number(rawValue));
    markDirty({ ...pending, fontSize });
  }

  function open(): void {
    if (closing) return;
    pending = { ...lastApplied };
    syncControlsFromPrefs(pending);
    updatePreview(pending);
    void syncFontChoicesUi(pending.fontFamily);
    syncApplyButton();
    settingsModal.hidden = false;
    settingsViewMode.focus();
  }

  function close(): void {
    if (closing) return;
    closing = true;
    settingsModal.classList.add("closing");
    settingsModal.addEventListener(
      "animationend",
      () => {
        settingsModal.hidden = true;
        settingsModal.classList.remove("closing");
        closing = false;
        pending = { ...lastApplied };
        opts.focusFallback.focus();
      },
      { once: true },
    );
  }

  settingsCloseBtn.addEventListener("click", () => close());
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) close();
  });
  settingsViewMode.addEventListener("change", () => {
    markDirty({
      ...pending,
      viewMode: normalizeAppearance({
        ...pending,
        viewMode: settingsViewMode.value,
      }).viewMode,
    });
  });
  settingsFontSize.addEventListener("input", () => {
    setFontSize(settingsFontSize.value);
  });
  settingsFontSize.addEventListener("change", () => {
    flushFontSize(settingsFontSize.value);
  });
  settingsFontSizeValue.addEventListener("input", () => {
    setFontSize(settingsFontSizeValue.value);
  });
  settingsFontSizeValue.addEventListener("change", () => {
    flushFontSize(settingsFontSizeValue.value);
  });
  settingsFontFamily.addEventListener("change", () => {
    const value = settingsFontFamily.value;
    if (value === "custom") {
      toggleCustomFontRow(true);
      settingsCustomFont.focus();
      return;
    }
    toggleCustomFontRow(false);
    markDirty({ ...pending, fontFamily: value });
  });
  settingsCustomFont.addEventListener("change", () => {
    const next = settingsCustomFont.value.trim();
    if (!next) {
      markDirty({ ...pending, fontFamily: "system" });
      return;
    }
    markDirty({ ...pending, fontFamily: next });
  });
  settingsResetBtn.addEventListener("click", () => {
    cachedChoices = null;
    lastChoicesSnapshot = null;
    markDirty({ ...DEFAULT_APPEARANCE });
    void syncFontChoicesUi(DEFAULT_APPEARANCE.fontFamily);
  });
  settingsApplyBtn.addEventListener("click", () => {
    if (!settingsApplyBtn.disabled) applyPending();
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
