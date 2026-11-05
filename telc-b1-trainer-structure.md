# telc B1 Trainer – App Structure

A static practice app for the telc Deutsch B1 / Zertifikat Deutsch written exam. It has no backend. Exams are plain JSON files, and the app turns them into an exam-style interface with a pausable stopwatch, answer inputs, auto-scoring, and a results screen.

---

## 1. File layout

```
index.html                         Page shell: top bar (brand + timer) and an empty <main id="app">
style.css                          Design tokens (light/dark) and all component styles
app.js                             All logic: routing, state, timer, rendering, scoring
exams/
  manifest.json                    List of available exams (what the start screen shows)
  telc-b1-uebungstest-1.json       One file per exam: all text, options, answer key
```

`index.html` has no `<html>`, `<head>` or `<body>` tags of its own. The Artifact host wraps it in a skeleton. Fonts (Fraunces, Public Sans) load from Google Fonts.

---

## 2. How it runs

| Concern | How it works |
|---|---|
| Hosting | Static files only. `app.js` loads data with `fetch('exams/...')` using relative URLs. |
| Rendering | `renderApp()` reads the URL hash, loads the exam if needed, then builds the view. DOM is built with a small helper `h(tag, props, ...children)` and `textContent`, never `innerHTML` for exam text. |
| Routing | Hash-based (see below). Browser back/forward works. |
| Persistence | `localStorage`, one entry per exam. Wrapped in try/catch, so the app still works if storage is blocked. |
| Dialogs | None. `alert`, `confirm` and `prompt` are not used. The "reset attempt" button uses an inline two-step confirm. |

### Routes

| Hash | View |
|---|---|
| `#exams` (or empty) | Exam list (from `manifest.json`) |
| `#exam/<examId>` | Block overview: three exam parts with progress |
| `#exam/<examId>/<blockId>/<sectionId>` | One exercise screen |
| `#exam/<examId>/results` | Results screen |

---

## 3. Data: `exams/manifest.json`

```json
{
  "exams": [
    {
      "id": "telc-b1-uebungstest-1",
      "title": "telc Deutsch B1 – Übungstest 1",
      "subtitle": "Zertifikat Deutsch, 13. Auflage 2020",
      "file": "telc-b1-uebungstest-1.json"
    }
  ]
}
```

`id` must equal the `id` inside the exam file. `file` is looked up under `exams/`.

---

## 4. Data: exam JSON

### Top level

| Field | Meaning |
|---|---|
| `id`, `title`, `source` | Identifiers and display text |
| `objectiveMaxPoints` | Max points of the auto-scored parts (180) |
| `writingMaxPoints` | Max points for Schriftlicher Ausdruck (45) |
| `writtenMaxPoints` | Max written total (225) |
| `writtenPassPoints` | Pass line for the written exam (135 = 60%) |
| `blocks[]` | The three timed exam parts |
| `sections[]` | Every exercise part, in exam order |

### Blocks

```json
{ "id": "hoeren", "title": "3 Hörverstehen", "officialTimeMinutes": 30,
  "sections": ["hoeren1", "hoeren2", "hoeren3"] }
```

Each block has its own stopwatch. `sections` lists section ids in order. Block titles must start with a number (`"1 + 2 …"`, `"3 …"`), because the app uses the leading digits as the big number on the overview card and strips them from the heading.

| Block id | Contains | Official time |
|---|---|---|
| `lesen-sprachbausteine` | lesen1, lesen2, lesen3, sb1, sb2 | 90 min |
| `hoeren` | hoeren1, hoeren2, hoeren3 | ca. 30 min |
| `schreiben` | schreiben | 30 min |

### Sections

Every section has: `id`, `block`, `title`, `type`, `instructions`, `maxPoints`, and (except writing) `pointsPerItem`. The `type` decides the layout and the answer format.

| `type` | Used for | Answer stored | Layout |
|---|---|---|---|
| `match` | Lesen 1, Lesen 3 | option key (`a`…) or `x` | Options listed on one side, dropdown per item on the other |
| `mc` | Lesen 2 | `a`/`b`/`c` | Passage on one side, radio questions on the other |
| `cloze-mc` | Sprachbausteine 1 | `a`/`b`/`c` | Gap text + radio options per gap |
| `cloze-bank` | Sprachbausteine 2 | key from a shared word list | Gap text + word list + dropdown per gap |
| `truefalse` | Hörverstehen 1–3 | `+` or `-` | Audio player + richtig/falsch buttons |
| `writing` | Schriftlicher Ausdruck | free text | Prompt + textarea + score entry |

#### `match`

```json
{ "type": "match", "optionLabel": "Anzeige", "allowX": true,
  "options": [{ "key": "a", "text": "…" }],
  "items":   [{ "number": 11, "text": "…", "correct": "b" }] }
```

`allowX: true` adds an "x – no match" choice (Lesen Teil 3). Choosing the same non-x option twice highlights both items with a warning.

#### `mc`

```json
{ "type": "mc",
  "passage": { "heading": "…", "subheading": "…", "paragraphs": ["…"] },
  "items": [{ "number": 6, "question": "…",
              "options": [{ "key": "a", "text": "…" }], "correct": "c" }] }
```

#### `cloze-mc`

The gap text is stored as a chain: `textBefore`, then for each gap the text that follows it.

```json
{ "type": "cloze-mc", "textBefore": "Liebe Karin, … nach Paris,",
  "items": [{ "number": 21, "textAfter": "das hat dann leider …",
              "options": [{ "key": "a", "text": "aber" }], "correct": "a" }] }
```

Rendered as `textBefore [gap 21] textAfter(21) [gap 22] textAfter(22) …`. Choosing an option fills the gap live.

#### `cloze-bank`

Same chain as `cloze-mc`, but with one shared word list instead of per-item options.

```json
{ "type": "cloze-bank", "wordBank": [{ "key": "a", "text": "BESONDERS" }],
  "textBefore": "…", "items": [{ "number": 31, "textAfter": "…", "correct": "h" }] }
```

Used words are struck through in the word list. Duplicate use is flagged. The section also has a `context` field (the Hotel-Pension Janosch advert) that is stored in the JSON but **not shown in the UI yet**.

#### `truefalse`

```json
{ "type": "truefalse", "audioLabel": "…",
  "transcripts": [{ "number": 41, "text": "…" }],
  "items": [{ "number": 41, "text": "…", "correct": "+" }] }
```

`transcripts` (the official Hörtexte) are hidden behind a "Transkript anzeigen" button. `number` is `null` for a single continuous dialogue.

#### `writing`

```json
{ "type": "writing", "prompt": "…email text…", "leitpunkte": ["…", "…", "…", "…"],
  "maxPoints": 45 }
```

### Item numbering

`items[].number` is the exam question number (1–60). Answers are stored globally by this number, so numbers must be unique within an exam.

---

## 5. State, timer, scoring

### State (in memory, saved to `localStorage`)

Key: `telcb1trainer:<examId>`

```json
{ "answers": { "1": "i", "41": "+" },
  "writing": { "text": "…", "score": 30, "checklist": { "0": true } },
  "timers":  { "hoeren": { "elapsed": 120000, "running": false, "lastStart": 0, "started": true } } }
```

The audio files you pick are held only in memory (`AudioFiles`) and are **not saved**. After a reload, choose the audio file again.

### Timer

- A stopwatch (counts up) per block, in `timers[blockId]`.
- It starts automatically the first time you open a section of that block.
- The Pause button stops it and shows a full-screen overlay, so you cannot answer while paused. The overlay's own button resumes.
- It autosaves every 5 seconds while running.
- It does **not** pause automatically when you switch tab or leave the page. Time keeps counting until you pause.
- Opening the Results screen pauses all timers.

### Scoring

```
section score   = (number of correct items) × pointsPerItem
objective total = sum of all non-writing sections        (max 180)
written total   = objective total + writing score        (max 225)
pass            = written total ≥ writtenPassPoints      (135)
```

| Section | Items | Points/item | Max |
|---|---|---|---|
| Lesen 1 | 5 | 5 | 25 |
| Lesen 2 | 5 | 5 | 25 |
| Lesen 3 | 10 | 2.5 | 25 |
| Sprachbausteine 1 | 10 | 1.5 | 15 |
| Sprachbausteine 2 | 10 | 1.5 | 15 |
| Hören 1 | 5 | 5 | 25 |
| Hören 2 | 10 | 2.5 | 25 |
| Hören 3 | 5 | 5 | 25 |
| Schriftlicher Ausdruck | – | – | 45 |

The writing score is **not** computed by the app. You paste your text to Claude, get a score based on the telc criteria (Aufgabenbewältigung, Kommunikative Gestaltung, Formale Richtigkeit, each A=5 / B=3 / C=1 / D=0, total × 3), then type it into the box in the writing section.

The Results screen shows: objective score, written total with pass/fail, total time, a per-section table, and a toggle listing wrong or unanswered items with your answer and the correct one.

---

## 6. Code map (`app.js`)

| Area | Functions |
|---|---|
| DOM helpers | `h`, `clear`, `mount`, `fmtClock`, `fmtPoints` |
| State and storage | `State`, `loadSavedState`, `saveState`, `hasSavedAttempt` |
| Timer | `startTimer`, `pauseTimer`, `getElapsed`, `updateTimerBox`, pause overlay |
| Routing | `parseHash`, `renderApp` |
| Views | `renderExamList`, `renderBlockOverview`, `renderSection`, `renderResults` |
| Section renderers | `renderMatchSection`, `renderMcSection`, `renderClozeSection`, `renderTrueFalseSection`, `renderWritingSection` |
| Scoring | `isItemCorrect`, `sectionScore`, `objectiveTotal`, `writtenTotal`, `describeAnswer` |

Interaction updates are targeted (toggle a class, set a chip's text) instead of re-rendering the whole screen. That keeps audio playback and typing focus from being reset. A full re-render happens only on navigation, tab switch, and pause/resume.

---

## 7. Styling (`style.css`)

- All colours are CSS variables on `:root`, with a dark set under `prefers-color-scheme: dark` and `[data-theme="dark"]`.
- The accent is a stamp-blue. Correct answers use green and wrong ones use red, like a teacher's marking.
- Fonts: Fraunces (headings), Public Sans (text and UI).
- Layouts: a two-column reading pane (`.two-col`) that stacks on narrow screens, a sticky top bar, and horizontally scrolling section tabs.

---

## 8. Adding a new exam

1. Extract the new PDF into `exams/<new-id>.json`, following section 4. Take the answer key from the PDF's Lösungsschlüssel and the transcripts from its Hörtexte.
2. Make sure `id` matches the filename convention and every question number is unique.
3. Add an entry to `exams/manifest.json`.
4. Check that the JSON parses and that the points add up (`maxPoints` of all sections = 225 including writing, 180 without).
5. Republish `index.html` with the same file map to keep the same URL.

The start screen lists every exam in the manifest. Once you open one, you choose the audio file inside each Hörverstehen section.

---

## 9. Known limitations

- **No audio sync.** The app does not know the track timings of your audio. You press play yourself.
- **Sprachbausteine 2 advert not shown.** The `context` field is not rendered yet.
- **Timer does not auto-pause** when you leave the tab.
- **Writing is scored outside the app**, by pasting the text into the chat.
- **No oral exam (Mündlicher Ausdruck).** It needs a partner and cannot be practised in this interface.
- **Offline use.** Opening `index.html` directly from disk fails because browsers block `fetch` of local files. Serve the folder instead (`python3 -m http.server`) or use the hosted version.
- **Character encoding.** The page relies on the host's UTF-8 declaration. A bare static server without charset headers can display German letters wrongly in `app.js` text.
