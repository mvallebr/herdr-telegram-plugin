# Step 2: Install the Plugin

## Clone the repo

```bash
git clone https://github.com/mvallebr/herdr-telegram-plugin
cd herdr-telegram-plugin
```

## Install dependencies and build

```bash
npm install
npm run build
```

This compiles TypeScript to `dist/`. The compiled output is what the daemon runs.

## Verify

```bash
npm test
# 45 passed (45)
```

## What you get

```
herdr-telegram-plugin/
├── dist/           # Compiled JS (what runs)
├── src/            # TypeScript source
│   ├── daemon.ts       # Main daemon (bot + watcher)
│   ├── wait-loop.ts    # Content polling + response extraction
│   ├── watcher.ts      # Tab → topic sync
│   └── ...
├── tests/          # Vitest tests
├── docs/           # This documentation
└── package.json
```

## Next

→ [Step 3: Configure & Run](/tutorial/configure)
