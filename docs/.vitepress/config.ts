import { defineConfig } from "vitepress";

export default defineConfig({
  title: "herdr-telegram-plugin",
  description:
    "Remote control herdr agents from Telegram. Each agent tab gets its own forum topic — type a message, get the response back.",
  lang: "en-US",
  base: "/herdr-telegram-plugin/",
  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    logo: {
      src: "/logo.svg",
      alt: "herdr-telegram-plugin",
    },
    nav: [],

    sidebar: [
      {
        text: "Tutorial",
        items: [
          { text: "Overview", link: "/tutorial/" },
          { text: "1. Create a Telegram Bot", link: "/tutorial/create-bot" },
          { text: "2. Install the Plugin", link: "/tutorial/install" },
          { text: "3. Configure & Run", link: "/tutorial/configure" },
          { text: "4. Pair & First Message", link: "/tutorial/first-run" },
          { text: "5. Daily Usage", link: "/tutorial/daily-usage" },
        ],
      },
      {
        text: "Guide",
        items: [
          { text: "Configuration", link: "/guide/configuration" },
          { text: "Agent Support", link: "/guide/agent-support" },
          { text: "Commands", link: "/guide/commands" },
          { text: "Troubleshooting", link: "/guide/troubleshooting" },
        ],
      },
      {
        text: "Internals",
        items: [
          { text: "How it Works", link: "/internals/how-it-works" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/mvallebr/herdr-telegram-plugin" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/mvallebr/herdr-telegram-plugin/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Marcelo Valle",
    },
  },

  markdown: {
    lineNumbers: true,
  },
});
