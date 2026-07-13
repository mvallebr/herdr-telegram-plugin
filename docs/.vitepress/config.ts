import { defineConfig } from "vitepress";

export default defineConfig({
  title: "herdr-telegram-plugin",
  description: "Telegram bot companion for herdr — remote control agents via forum topics",
  lang: "en-US",
  base: "/herdr-telegram-plugin/",
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started/installation" },
    ],
    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Installation", link: "/getting-started/installation" },
          { text: "Create a Telegram Bot", link: "/getting-started/telegram-bot" },
          { text: "First Run", link: "/getting-started/first-run" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/configuration" },
          { text: "Commands", link: "/commands" },
        ],
      },
      {
        text: "Internals",
        items: [
          { text: "How it Works", link: "/how-it-works" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/mvallebr/herdr-telegram-plugin" },
    ],
    search: {
      provider: "local",
    },
  },
  markdown: {
    theme: "github-dark",
    lineNumbers: true,
  },
});
