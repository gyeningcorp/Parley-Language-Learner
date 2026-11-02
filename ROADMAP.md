# Parley product priorities

The audio-first recall engine is the foundation. Grow the app around useful practice, dependable content, and visible progress.

1. **Standalone practice (this change):** user-authored lessons and a searchable learned phrasebook with playback and due filtering.
2. **Reliable course content:** expand reviewed built-in lessons for the existing 11 starter languages. Distinguish supported courses from languages that depend on generated content and installed voices. Validate translations before presenting a course as complete.
3. **Progress and retention:** daily practice goals, session history, streaks based on local calendar dates, and a dashboard showing due reviews and weak phrases. Keep hands-free exposure separate from self-graded recall accuracy.
4. **Portable progress:** downloadable backups and validated restore, clear local-storage failure messages, and optional authenticated sync outside Claude. Avoid silently losing progress when switching devices or clearing browser data.
5. **Speaking practice:** opt-in recording and playback for shadowing, followed by pronunciation feedback with explicit microphone permission and clear recording retention. Preserve text and audio practice when speech recognition is unavailable.
6. **Standalone lesson generation:** server-side generation with authenticated requests, rate limits, output validation, and visible error recovery. Provider credentials must stay off the client.
7. **App polish:** accessible modal focus management, onboarding with voice preview, installable offline shell and cached course content, and real-device audio checks on iOS and Android.

Before release, resolve the original app PR into main. This upgrade is based on `add-parley-app`, which currently contains the app while main contains only the repository stub.
