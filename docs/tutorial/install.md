# Step 2: Install the Plugin

## Option A: herdr plugin install (recommended)

```bash
herdr plugin install github.com/mvallebr/herdr-telegram-plugin
```

Herdr clones the repo, runs `npm ci` + `npm run build`, and registers the plugin.

## Option B: Manual clone and build

```bash
git clone https://github.com/mvallebr/herdr-telegram-plugin
cd herdr-telegram-plugin
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
