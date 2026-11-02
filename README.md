# Parley Language Learner

An audio-first language trainer for 110+ languages. You hear an English cue, say the phrase out loud during a pause, then hear a native voice give the answer. Each phrase comes back at growing gaps until it sticks.

It is a single HTML file with no dependencies and no build step to run it.

## How a lesson works

1. **Answer before you hear it.** An English cue, a countdown, then the native answer. Pulling the phrase from memory is what makes it stick.
2. **Graduated recall.** Each phrase returns at 5 seconds, 25 seconds, 2 minutes and 10 minutes during the lesson, then 1 day, 5 days, 25 days, 4 months and 2 years. A miss sends it back to a short gap.
3. **Backward build-up.** Long phrases are taught from the end ("favor", then "por favor"), keeping the natural stress and melody.
4. **A small core, used at once.** About a dozen high-frequency phrases per lesson, recombined into new sentences you build yourself, framed by a short conversation you hear at the start and understand by the end.

Two modes: **Active** (tap Got it / Missed after each answer) and **Hands-free** (plays straight through like an audio course).

## Practice studio

- **Create a lesson:** add 3–14 trusted translations, one per line as `English cue | translation | optional romanization`. Your lessons are saved locally under Your topics and use the same audio and spaced-recall engine. This works without Claude.
- **Phrasebook:** search learned phrases by translation, English cue, or romanization; filter to due reviews and listen at your chosen speech speed.

## Languages and content

- One 30-lesson path shared by every language (`SYLLABUS` in `src/content.js`).
- Lesson 1 is built in for Spanish, French, German, Italian, Portuguese, Japanese, Mandarin, Korean, Russian, Arabic and Hindi.
- Every other lesson, every other language, and lessons on any topic you type are written by Claude on demand, building on the phrases you already know. Lessons written this way can contain mistakes, especially in less widely spoken languages.

## Audio

Speech uses the device's built-in voices through the Web Speech API. Voices are ranked clearest first (Premium, Enhanced, Natural, Siri, Google, Standard, Basic), and Settings › Voices lets you pick and preview the language speaker and the English narrator. Languages with no voice on the device fall back to text.

For the clearest audio on iPhone, download an Enhanced or Premium voice under Settings › Accessibility › Spoken Content › Voices.

## Running it

| Where | What works |
| --- | --- |
| As a Claude artifact | Everything: Claude-written lessons (`claude.use("sample")`) and progress synced to your Claude account (`claude.use("db")`). |
| Any static host or opened locally | Built-in Lesson 1 for 11 languages, reviews, all settings. Progress is kept in the browser's local storage. Claude-written lessons are unavailable. |

## Project layout

```
index.html        built, self-contained app (open this)
src/shell.html    markup and styles
src/content.js    languages, 30-lesson syllabus, built-in Lesson 1 content
src/app.js        scheduler, speech player, UI, storage, lesson writer
build.js          assembles src/ into index.html
tests/smoke.js    runs full lessons at 60x speed in headless Chromium
```

## Develop

```bash
node build.js                     # rebuild index.html after editing src/
npm install && npx playwright install chromium
npm test                          # build + smoke test
```

## License

MIT
