---
layout: home

hero:
  name: herdr-telegram-plugin
  text: Remote control herdr agents from Telegram
  tagline: Send messages to forum topics and the agent responds directly in the chat
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/mvallebr/herdr-telegram-plugin

features:
  - icon: 💬
    title: Forum Topic Mapping
    details: Each herdr agent tab gets its own Telegram forum topic. Conversations stay organized.
  - icon: ⚡
    title: Real-time Response
    details: Content-based polling with stability detection ensures you get the full response, not fragments.
  - icon: 🔧
    title: Commands
    details: /digest, /bind, /pair, /unpair — control everything from the chat.
  - icon: 🛡️
    title: Safe by Default
    details: Pairing requires explicit authorization. Rate-limited progress updates. Timeout protection.
---

## 30-second Quickstart

```bash
# 1. Install
git clone https://github.com/mvallebr/herdr-telegram-plugin
npm install && npm run build

# 2. Configure
echo '[telegram]' > ~/.config/herdr-telegram/config.toml
echo 'bot_token = "YOUR_BOT_TOKEN"' >> ~/.config/herdr-telegram/config.toml

# 3. Run
node dist/index.js --daemon
```

Then open Telegram, find your bot, and send `/pair`. The watcher automatically creates a topic for each herdr tab. Type a message in any topic — the agent responds.
