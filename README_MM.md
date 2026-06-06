# Myanso

![Myanso icon](icon.png)

မြန်မာစာလုံးများကို **မှန်ကန်စွာ ဖော်ပြပေးနိုင်သော** desktop terminal တစ်ခု ဖြစ်သည်။ ပုံမှန် terminal များနှင့် ပုံမှန် xterm.js တို့သည် မြန်မာစာလုံးတွဲ (အက္ခရာ + ဗျည်းတွဲ + အသတ် + သရများ) ကို cell တစ်ခုစီအဖြစ် ခွဲခြားလိုက်သောကြောင့် font မှ ပုံဖော်မပေးနိုင်ဘဲ လွဲမှားစွာ ဖော်ပြလေ့ရှိကြသည်။

Myanso သည် **Electron** နှင့် **xterm.js 6** ပေါ်တွင် တည်ဆောက်ထားသော ပုံမှန် PTY terminal တစ်ခုဖြစ်ပြီး tabs များ၊ split panes များ၊ window အများအပြား ဖွင့်နိုင်ခြင်း၊ ရှာဖွေနိုင်ခြင်းနှင့် နှိပ်၍ရသော link များ ပါဝင်သည်။ ၎င်း၏ ထူးခြားချက်မှာ shell၊ full-screen TUI များ (vim) နှင့် AI CLI များ (Claude Code၊ Codex CLI၊ agy) တို့တွင် မြန်မာစာလုံး ပုံဖော်ခြင်း (shaping) နှင့် column များ တန်းညှိခြင်း (column alignment) တို့ကို မှန်ကန်စွာ လုပ်ဆောင်ပေးနိုင်ခြင်း ဖြစ်သည်။

> ရည်မှန်းချက် - **perfect monospace alignment ထက် မှန်ကန်သော မြန်မာစာသား ဖတ်ရှုနိုင်မှုကို ဦးစားပေးရန်။** ၎င်းနှစ်ခု ထပ်တူမကျပါက Myanso သည် ဖတ်ရလွယ်ကူသော စာသားဖြစ်ရန် ပိုမိုဦးစားပေးသည်။

## လုပ်ဆောင်ချက်များ (Features)

- **မှန်ကန်သော မြန်မာစာ ဖော်ပြမှု** — စာလုံးတွဲအပြည့်အစုံများ (ဥပမာ - `မြန်မာ`၊ `ဘူး`၊ `တို့`) အား `မ ြ န ်` ဟု ကွဲထွက်မသွားဘဲ စာလုံးတစ်လုံးတည်းအဖြစ် ပုံဖော်ပေးသည်။
- **Application တစ်ခုချင်းစီအလိုက် width သတ်မှတ်ပေးခြင်း** — ကွဲပြားသော software များသည် မြန်မာစာလုံး/သင်္ကေတတစ်ခု၏ အကျယ် (width) ကို ကွဲပြားစွာ ယူဆကြသည်။ Myanso သည် လက်ရှိအသုံးပြုနေသော app (foreground app) ကို အလိုအလျောက် သိရှိပြီး ၎င်းနှင့် ကိုက်ညီအောင် ညှိပေးသည်။ ထို့ကြောင့် zsh, vim, agy, Claude Code နှင့် Codex CLI တို့တွင် cursor နှင့် column များသည် လွဲချော်ခြင်းမရှိဘဲ တစ်တန်းတည်း ရှိနေမည် ဖြစ်သည် (အောက်တွင် ဆက်လက်ဖတ်ရှုပါ)။
- **Tabs & split panes** — မည်သည့် pane ကိုမဆို ညာဘက် သို့မဟုတ် အောက်ဘက်သို့ binary tree ပုံစံဖြင့် split ခွဲနိုင်ပြီး dividers များကို drag ဆွဲ၍ အကျယ်အဝန်း ညှိနိုင်သည်။
- **Windows အများအပြား ဖွင့်နိုင်ခြင်း** — `Cmd+N` ဖြင့် window အသစ် ဖွင့်နိုင်ပြီး **tab တစ်ခုကို window တစ်ခုမှ အခြားတစ်ခုသို့ drag ဆွဲ၍ ရွှေ့ပြောင်းနိုင်သည်** (သို့မဟုတ် desktop ပေါ်သို့ drop လုပ်ပြီး window အသစ်တစ်ခုအဖြစ် ခွဲထုတ်နိုင်သည်)။ ရွှေ့ပြောင်းစဉ်အတွင်း PTY process များ ပျက်ပြယ်သွားခြင်း မရှိပါ။
- **ရှာဖွေခြင်း (Search)** — pane တစ်ခုချင်းစီအလိုက် `Cmd+F` ဖြင့် floating find bar ကို အသုံးပြုကာ တူညီသော စကားလုံးများကို highlights ပြသပေးနိုင်သည်။
- **နှိပ်၍ရသော link များ (Clickable links)** — OSC 8 hyperlinks နှင့် URL များကို click နှိပ်ရုံဖြင့် ဖွင့်နိုင်သည်။ (`file://` link များကို OS မှတစ်ဆင့် ဖွင့်ပေးပြီး အခြား link များကို browser တွင် ဖွင့်ပေးသည်)။
- **စမတ်ကျသော ခေါင်းစဉ်များ (Smart titles)** — OSC 7 ကို အသုံးပြု၍ tab ခေါင်းစဉ်များကို လက်ရှိအလုပ်လုပ်နေသော directory (working directory) အလိုက် ပြောင်းလဲပေးသည်။
- **ဆက်တင်များ (Settings)** — theme, font, font size, letter-spacing တို့ကို တိုက်ရိုက်ပြောင်းလဲနိုင်ပြီး ဆက်တင်များကို သိမ်းဆည်းပေးထားသည်။
- **macOS အဆင်ပြေစေမည့် အချက်များ** — dock icon ပေါ်သို့ folder တစ်ခုကို ဆွဲထည့်ပြီး terminal ဖွင့်နိုင်ခြင်း၊ session ထဲသို့ ပုံတစ်ပုံကို ဆွဲထည့်ခြင်းဖြင့် ၎င်း၏ path လမ်းကြောင်းကို paste လုပ်နိုင်ခြင်း။
- **Cross-platform builds** — macOS (DMG)၊ Windows (NSIS) နှင့် Linux (AppImage) တို့အတွက် build လုပ်နိုင်သည်။

## မြန်မာစာ ဖော်ပြမှု အလုပ်လုပ်ပုံ

ပြဿနာနှစ်ရပ်ဖြစ်သော **ပုံဖော်ခြင်း (shaping)** နှင့် **အကျယ် (width)** တို့ကို မတူညီသော နေရာနှစ်ခုတွင် ဖြေရှင်းထားသည်။

### ၁။ ပုံဖော်ခြင်း (Shaping - xterm patch)

`patches/patch-xterm-myanmar.js` သည် minified ဖြစ်ထားသော `@xterm/xterm` build ကို ပြင်ဆင်ပေးသည်။ သို့မှသာ DOM renderer သည် ပုံစံတူ cell များကို **`<span>` တစ်ခုတည်း** အဖြစ် ပေါင်းစည်းပေးမည်ဖြစ်ပြီး browser မှ မြန်မာစာလုံးတွဲတစ်ခုလုံးကို မှန်ကန်စွာ ပုံဖော်နိုင်မည်ဖြစ်သည်။ (မူရင်း xterm သည် cell တစ်ခုချင်းစီကို ၎င်း၏ ကိုယ်ပိုင် `letter-spacing` ရှိသော span တစ်ခုစီအဖြစ် သတ်မှတ်သောကြောင့် စာလုံးတွဲများကို ပြတ်တောက်သွားစေသည်။) ဤ patch သည် idempotent ဖြစ်ပြီး `npm install` လုပ်တိုင်း ပြန်လည်ပတ်သည်။ ၎င်းကို **xterm v6.0.0 တွင် ပင်တိုင်သတ်မှတ်ထားသည်** — version မြှင့်လိုက်ပါက minified identifier များ ပြောင်းလဲသွားမည်ဖြစ်ပြီး find/replace string များကို ပြန်လည်မရှာမချင်း patch အလုပ်လုပ်တော့မည် မဟုတ်ပါ။

### ၂။ အကျယ် (Width - renderer တွင်း application အလိုက် သတ်မှတ်ခြင်း)

Application များသည် မြန်မာစာလုံး/သင်္ကေတတစ်ခု ယူရမည့် column ပမာဏကို သဘောထားကွဲလွဲကြပြီး **မည်သည့်သတ်မှတ်ချက်တစ်ခုတည်းကမျှ အားလုံးနှင့် အဆင်မပြေနိုင်ပါ**။ ထို့ကြောင့် Myanso သည် terminal တစ်ခုချင်းစီအတွက် width provider သုံးခုကို သတ်မှတ်ထားပြီး screen နှင့် foreground process အပေါ် မူတည်ကာ ၎င်းတို့ကို ပြောင်းလဲအသုံးပြုပေးသည် -

| Provider | သင်္ကေတများ (Marks) | အသုံးပြုသည့်နေရာ (Used for) |
|---|---|---|
| `myan-shell` | သင်္ကေတများအားလုံး၏ width သည် 0 ဖြစ်သည် (ဗျည်း သို့မဟုတ် အခြေခံစာလုံးနှင့် ပေါင်းစပ်သည်) | zsh / shell (macOS ၏ `wcwidth` သည် သင်္ကေတများကို 0 အဖြစ် ရေတွက်သည်) |
| `myan-std` | non-spacing (Mn) သည် 0 ဖြစ်ပြီး spacing (Mc, ဥပမာ - `ာ း ြ`) သည် 1 ဖြစ်သည် | vim၊ agy၊ iTerm2၊ Codex CLI — ယူနီကုဒ်စံနှုန်း (Unicode standard) |
| `myan-allone` | သင်္ကေတတိုင်း၏ width သည် 1 ဖြစ်သည် (သီးခြား cell တစ်ခုစီ) | Claude Code (သင်္ကေတအားလုံးကို 1 အဖြစ် ရေတွက်သည်) |

Main process သည် PTY တစ်ခုချင်းစီ၏ foreground process (`node-pty` ၏ `.process`) ကို စစ်ဆေးပြီး renderer သို့ အကြောင်းကြားပေးသည်။ ထို့နောက် renderer မှ သင့်တော်သော provider ကို ရွေးချယ်သည်။ Claude Code ကို ၎င်း၏ terminal title (`Claude Code`) သို့မဟုတ် ၎င်း၏ version ပါဝင်သော process title (ဥပမာ - `2.1.165`) ဖြင့် စစ်ဆေးသိရှိနိုင်ပြီး ၎င်းပိတ်သွားပြီးနောက် title အဟောင်း ကျန်မနေစေရန်လည်း စနစ်တကျ ကာကွယ်ထားသည်။ Codex CLI သည် ယေဘုယျကျသော `node` process တစ်ခုအဖြစ် သတင်းပို့သောကြောင့် main process က (`pgrep` + `ps` အသုံးပြု၍) command line အပြည့်အစုံကို စစ်ဆေးကာ `codex` ဖြစ်ကြောင်း ရှာဖွေဖော်ထုတ်ပေးသည်။ ၎င်းသည် standard widths ကို အသုံးပြုသော်လည်း **normal** screen ပေါ်တွင် run သောကြောင့် `myan-std` ကို သုံးရန် အတင်းအကျပ် သတ်မှတ်ပေးရသည် (သို့မဟုတ်ပါက spacing marks များ ပျောက်ဆုံးသွားလိမ့်မည် - `မြန်မာ` → `မြန်မ`)။

### ၃။ စင့်ခရိုနိုက်ဇ်ဖြစ်သော output (Synchronized output)

အချို့ TUI များသည် ရိုက်နှိပ်လိုက်သော key တိုင်း၏ echo ကို DEC mode **2026** (synchronized output) ဖြင့် ပတ်ရံပေးလေ့ရှိသည်။ xterm.js 6 တွင် 2026 block အတွင်းရှိ cell တစ်ခုထဲသို့ ပေါင်းစပ်သင်္ကေတ (combining mark) ရောက်လာသောအခါ repaint မလုပ်ပေးနိုင်သည့် bug တစ်ခု ရှိသည်။ ထို့ကြောင့် စာရိုက်နေစဉ်အတွင်း အဆိုပါသင်္ကေတများ မပေါ်ဘဲ ပျောက်ကွယ်သွားတတ်သည်။ Myanso သည် PTY output မှ **2026 markers များကို ဖယ်ထုတ်လိုက်ခြင်း** ဖြင့် အဆိုပါ bug ကို ရှောင်လွှဲသည်။ rAF-debounced renderer သည် frames များကို စုစည်းပေးပြီးဖြစ်သောကြောင့် မျက်နှာပြင်တုန်ခါခြင်း (flicker) မရှိစေဘဲ အဆင်ပြေစွာ လုပ်ဆောင်နိုင်သည်။

### သိထားရမည့် ကန့်သတ်ချက်များ (Known limits)

- **vim ၏ `'maxcombine'`** သည် ပုံမှန်အားဖြင့် **2** သာ သတ်မှတ်ထားသည် — ၎င်းသည် စာလုံးတစ်လုံးတွင် ပေါင်းစပ်သင်္ကေတ ၂ ခုကိုသာ *ဖော်ပြပေး* သောကြောင့် `တို့` ကဲ့သို့သော သင်္ကေတ ၃ ခုပါဝင်သည့် စာလုံးသည် `တို` ဟုသာ ပေါ်နေလိမ့်မည် (ဖိုင်တွင်းရှိ စာသားမှာမူ မှန်ကန်စွာ ရှိနေပါသည်)။ သင်၏ `~/.vimrc` တွင် `set maxcombine=6` ကို ထည့်သွင်းခြင်းဖြင့် ဤပြဿနာကို အမြဲတမ်း ဖြေရှင်းနိုင်သည် -

  ```bash
  vi ~/.vimrc
  ```
  ```vim
  set maxcombine=6
  ```
- စာလုံးပုံဖော်မှု မှန်ကန်စေရန် ရည်ရွယ်ချက်ရှိရှိ ညှိနှိုင်းထားရခြင်းကြောင့် အချို့သော wide/proportional glyphs များ၏ Column alignment များသည် အနည်းငယ် လွဲချော်မှု ရှိနိုင်သည်။

## တည်ဆောက်ပုံစနစ် (Architecture)

ဖိုင်လေးဖိုင်သာ ပါဝင်ပြီး build step မလိုပါ -

```
နှိပ်လိုက်သော ခလုတ် (keystroke) → renderer.js (xterm onData) → IPC pty-input → main.js → node-pty
node-pty အချက်အလက် → main.js (စုစည်းခြင်း + strip 2026) → IPC pty-data → renderer.js → xterm
```

- **`main.js`** — Electron main process ဖြစ်သည်။ module-level `ptys` map ထဲတွင် pane တစ်ခုစီအတွက် `node-pty` တစ်ခုစီ ရှိသည်။ tab များကို window များအကြား ရွှေ့ပြောင်းနိုင်ရန်အတွက် PTY process များသည် window များထက် ပိုမိုကြာရှည်စွာ တည်ရှိနေမည် (outlive) ဖြစ်သည်။ multi-window လုပ်ဆောင်ချက်များ၊ app menu (xterm focus ရှိနေစဉ်တွင်လည်း keyboard shortcuts များ အလုပ်လုပ်စေရန်)၊ window များအကြား tab ဆွဲရွှေ့ခြင်း (HTML5 DnD သည် window များကို မကျော်ဖြတ်နိုင်သောကြောင့် screen coordinates များကို သုံးထားသည်)၊ foreground-process poller နှင့် mode-2026 ကို ဖယ်ထုတ်ခြင်း (strip) တို့ကို ကိုင်တွယ်ဆောင်ရွက်ပေးသည်။ renderer မှ node-pty/xterm တို့ကို တိုက်ရိုက် `require()` လုပ်နိုင်ရန် `nodeIntegration` ကို အသုံးပြုထားသည်။
- **`renderer.js`** — UI တစ်ခုလုံးဖြစ်သော tab bar၊ split-pane tree၊ settings၊ find၊ links များနှင့် xterm ချိတ်ဆက်မှုအားလုံး (application အလိုက် မြန်မာစာလုံး အကျယ်သတ်မှတ်ပေးသည့် `setupMarkWidth`၊ `paneWantsAllOne` စသည့် logic များ အပါအဝင်) ကို ကိုင်တွယ်သည်။
- **`index.html`** — markup နှင့် styles များ ဖြစ်သည်။
- **`patches/patch-xterm-myanmar.js`** — စာလုံးပုံဖော်မှုအတွက် patch ဖြစ်သည် (အထက်တွင် ကြည့်ရန်)။

ကုဒ်အဆင့်အထိ အသေးစိတ်လေ့လာရန် [CLAUDE.md](CLAUDE.md) တွင် ဖတ်ရှုနိုင်ပါသည်။

## ညွှန်ကြားချက်များ (Commands)

```bash
npm install          # dependency များကို install လုပ်ခြင်း + postinstall (electron-rebuild နှင့် patch ကို အသုံးပြုခြင်း)
npm start            # application ကို စတင်ပတ်ခြင်း
npm run rebuild      # Electron ၏ ABI နှင့် ကိုက်ညီအောင် node-pty ကို ပြန်လည် တည်ဆောက်ခြင်း (rebuild)
npm run patch-xterm  # မြန်မာစာပုံဖော်မှု patch ကို ပြန်လည်အသုံးပြုခြင်း (idempotent ဖြစ်သည်)
npm run dist         # install လုပ်ပြီး အသုံးပြုနိုင်မည့် ဖိုင်တွဲများ ထုတ်လုပ်ခြင်း (DMG / NSIS / AppImage)
```

စနစ်တကျ စစ်ဆေးသည့် test သို့မဟုတ် linter များမရှိပါ — စစ်ဆေးခြင်းကို manual သာ လုပ်ဆောင်ရပါမည် - shell၊ vim နှင့် Claude Code၊ Codex CLI သို့မဟုတ် agy ကဲ့သို့သော TUI များတွင် မြန်မာစာများကို ရိုက်ထည့်ခြင်း သို့မဟုတ် paste ပြုလုပ်ခြင်းဖြင့် စစ်ဆေးနိုင်သည်။

## ထည့်သွင်းအသုံးပြုခြင်း (Install)

နောက်ဆုံးထွက် build ဖိုင်များကို [Releases](../../releases) စာမျက်နှာတွင် ရယူနိုင်သည်။

**macOS** (unsigned) - `Myanso.app` ကို `/Applications` သို့ drag ဆွဲထည့်ပါ၊ ထို့နောက် quarantine flag ကို ဖျက်ပစ်ပါ -

```bash
xattr -d com.apple.quarantine /Applications/Myanso.app
```

## ဆော့ဖ်ဝဲရေးသားထုတ်လုပ်ခြင်း (Development)

Node.js 18+ လိုအပ်ပါသည်။

```bash
git clone https://github.com/saturngod/myanso.git
cd myanso
npm install
npm start
```

> `npm install` ကို `sudo` ဖြင့် မည်သည့်အခါမျှ မလုပ်ပါနှင့် — ၎င်းသည် `~/Library/Caches/electron` နှင့် `node_modules/node-pty/build` တို့ကို `root` အပိုင် ဖြစ်သွားစေသည်။ အကယ်၍ Electron မပွင့်လာပါက `sudo rm -rf ~/Library/Caches/electron` ဟု လုပ်ဆောင်ပြီး `npm install` ကို ထပ်မံလုပ်ဆောင်ပါ။

## Keyboard ဖြတ်လမ်းများ (Keyboard shortcuts)

| ဖြတ်လမ်း (Shortcut) | လုပ်ဆောင်ချက် (Action) |
|---|---|
| `Cmd+N` | Window အသစ်ဖွင့်ခြင်း |
| `Cmd+T` | Tab အသစ်ဖွင့်ခြင်း |
| `Cmd+W` | Pane / Tab ပိတ်ခြင်း |
| `Cmd+D` | ညာဘက်သို့ Split ခွဲခြင်း |
| `Cmd+Shift+D` | အောက်ဘက်သို့ Split ခွဲခြင်း |
| `Cmd+[` / `Cmd+]` | ယခင် / နောက် pane သို့ ကူးပြောင်းခြင်း |
| `Cmd+1`–`9` | Go to tab |
| `Cmd+F` | ရှာဖွေခြင်း |
| `Cmd+,` | ဆက်တင်များ (Settings) |
| `Cmd+ +` / `Cmd+ -` / `Cmd+0` | စာလုံးအရွယ်အစား ကြီးခြင်း / သေးခြင်း / နဂိုအတိုင်းပြန်ထားခြင်း |

(Windows/Linux တွင် `Ctrl` ဖြစ်သည်။)

## ပါဝင်ကူညီခြင်း (Contributing)

ပါဝင်ကူညီရန် ကြိုဆိုပါသည် — အထူးသဖြင့် **Linux/Windows စမ်းသပ်မှုများ** နှင့် မြန်မာစာလုံး အလွဲအချော်ဖြစ်သော အခြေအနေများ (Myanmar edge cases) အတွက် ဖြစ်သည်။ အကယ်၍ စာလုံးပုံဖော်မှု မှားယွင်းသော မြန်မာစာလုံးတွဲတစ်ခုခုကို တွေ့ရှိပါက သင်ရောက်ရှိနေသော app (shell / vim / မည်သည့် CLI) နှင့် ရိုက်ထည့်ထားသော စာသားအတိအကျကို မှတ်သားထားပေးပါ — width ဆိုင်ရာ bug များသည် များသောအားဖြင့် သတ်မှတ်ထားသော app အပေါ်တွင်သာ မူတည်တတ်သည်။

## လိုင်စင် (License)

MIT
