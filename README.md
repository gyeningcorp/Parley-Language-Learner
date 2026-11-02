# Parley Language Learner

A standalone audio-first language trainer. Listen to a conversation, answer English cues aloud before hearing the translation, build phrases backward, combine familiar expressions, and take one speaker's part.

Parley uses original lesson material and device text-to-speech. It contains no commercial course scripts or recordings. Duration varies with speech speed, pauses, review load, and grading.

## Run

Requires Node.js 22.12 or newer. No production dependencies are needed.

```sh
node build.js
npm start
```

Open http://127.0.0.1:3000. Included lessons, review, settings, phrasebook, and user-authored lessons work without a model account. Opening index.html directly runs included content; generation and server course loading require the server.

## Available content

- 110 listed languages, each with a 30-step syllabus.
- 30 included Spanish (Latin America) lessons; Lessons 6–30 are explicitly marked as AI drafts awaiting language review.
- Additional first lessons bring the included library to 41 playable lessons across 12 locale codes. Course studio reports exact coverage.
- Unfilled slots are not counted as completed lessons.
- The full 3,300-lesson catalog has NOT been generated or reviewed. It needs a configured model account and a catalog job.

## Connect standalone generation

1. Copy .env.example to .env on the server.
2. Set OPENAI_API_KEY to your model API credential.
3. Set PARLEY_ADMIN_TOKEN to a random value of at least 24 characters. Generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

4. Start or restart npm start.
5. In Course studio, sign in with the administrator token and build a selected language or all 110 courses.

The API key stays on the server. The browser receives an HttpOnly administrator session cookie. Existing lessons are public; generation and course jobs require administrator access. Learner progress and personal lessons stay in browser local storage.

Generation uses the OpenAI Responses API with a strict lesson schema. PARLEY_MODEL selects the model (default gpt-5.4). See [official structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) and [model documentation](https://developers.openai.com/api/docs/models/gpt-5.4). Credentials, account access, and usage charges must be configured separately.

## Build all courses through Lesson 30

Run the server, then use Course studio or:

```sh
npm run catalog:build -- --languages all
# Or a smaller selection:
npm run catalog:build -- --languages fr-FR,ja-JP
```

The CLI reads .env and submits a durable job to the local server. Use --url https://your-host.example for a remote server; it refuses unencrypted remote HTTP.

Each course builds in lesson order with earlier vocabulary as context. Saved lessons are skipped. Phrase counts, fields, duplicates, two-speaker dialogue, and backward-build structure are checked before saving. Jobs track progress, pause/resume, and recover after server restart. Errors stop a job for review rather than counting failures as completed content. Pause waits for the current lesson request to finish. A canceled browser request may still finish a numbered lesson on the server.

Schema validation checks STRUCTURE, not translation correctness. Drafts need language review, especially for less widely represented languages, dialects, romanization, register, and pronunciation. Test fixtures are never production lessons.

## Learning and audio

- New learners start hands-free; active mode supports Got it / Missed self-grading.
- Hands-free records exposure, not measured accuracy.
- Only a finished lesson is marked complete. Early exits save phrase practice.
- Earlier phrases return across lessons; successful early review preserves future due dates.
- Recall respects scheduled gaps. Listening passages and quiet breaks fill gaps.
- Device voices vary by language. Missing voices fall back to text; a listed course does not guarantee device audio support.
- Phrasebook searches translations, English cues, and romanization, with playback and due filtering.
- Personal lessons accept 3–14 lines as English cue | translation | optional romanization.

## Storage and deployment

PARLEY_DATA_DIR (default ./data) holds courses/<locale>/<lesson>.json and jobs.json. Back up this directory. It is ignored by Git and never served as a public directory; lessons are exposed only through the read API.

Run one server process per data directory. Multi-instance deployment needs shared durable storage and a distributed worker. Static-only hosts cannot run generation.

A Dockerfile supports a long-running container:

```sh
docker build -t parley .
docker run --env-file .env -p 3000:3000 -v parley-data:/app/data parley
```

For Docker, set HOST=0.0.0.0 and PARLEY_DATA_DIR=/app/data in the environment. For public hosting, use HTTPS and set PARLEY_PUBLIC_ORIGIN to the public origin so write-origin checks and secure cookies work behind the proxy. Never commit .env or put the provider key in client code.

No production deployment or real full-catalog generation is implied by this repository change.

## Tests

```sh
npm install
npx playwright install chromium
npm test
npm run test:server
```

Backend tests use a deterministic test provider, temporary storage, and real HTTP requests: authentication, secret paths, failures, validation, persistence, sequential generation, language counts, and restart recovery. Browser checks exercise guided lessons, active/hands-free practice, scheduling, phrase search, and personal lessons. Real-device audio and native-language review are separate checks.

## Files

- src/content.js: language catalog, syllabus, first lessons
- src/course.js and src/course-es.js: original Spanish draft course
- src/app.js and src/shell.html: browser and guided audio engine
- server/: standalone API, provider, persistent lessons, durable queue
- scripts/build-catalog.js: submit catalog builds
- build.js: assemble index.html
- tests/: backend and browser checks

MIT license.
