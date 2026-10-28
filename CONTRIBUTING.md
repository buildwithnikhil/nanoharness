# Contributing

Thanks for helping. The project is small on purpose, so the best changes keep it that way.

## Ground rules
- **No runtime dependencies**, and no network or filesystem code in the core `nanoharness` package. That code belongs in a companion package.
- New behaviour is **opt-in**. A change that alters defaults for existing users needs a strong reason and a note in `CHANGELOG.md`.
- Every change comes with a test. Tests use a scripted fake adapter, so they make no network calls.

## Setup

```sh
git clone https://github.com/buildwithnikhil/nanoharness
cd nanoharness
npm install
npm run test:all   # builds and tests the core and all companion packages
npm run typecheck:all   # builds the core, then typechecks every package
```

Building needs Node 22.18 or later, or 24.11 or later (the `tsup` bundler requires `^22.18 || ^24.11 || >=26`). The packages themselves run on Node 18 or later, and CI tests them on 18, 20, 22 and 24.

## Layout

| Path | Package |
|---|---|
| `src/` | `nanoharness` (core, `agents`, `graph`, `store`, `zod`) |
| `packages/anthropic` | `nanoharness-anthropic` |
| `packages/openai` | `nanoharness-openai` |
| `packages/fs` | `nanoharness-fs` |

## Pull requests
Keep them focused, update the README if behaviour changes, and add a line under the unreleased heading in `CHANGELOG.md`. A live test against a real provider runs only when `ANTHROPIC_API_KEY` is set.

## Releasing (maintainers)
1. Bump the version in the package's `package.json` and finish the `CHANGELOG.md` entry.
2. Tag and push: `v<version>` for the core, `anthropic-v<version>`, `openai-v<version>` or `fs-v<version>` for a companion package. The publish workflow builds, tests and publishes with provenance, using npm trusted publishing.
