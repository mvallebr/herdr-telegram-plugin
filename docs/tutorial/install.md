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

## Verify installation

```bash
herdr plugin list
# herdr-telegram-plugin  0.1.0  installed
```

You should see the plugin listed as installed. If you used the manual clone method, skip this check.

## Next

→ [Step 3: Configure & Run](/tutorial/configure)
