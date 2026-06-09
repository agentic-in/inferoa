import type { Config } from "@docusaurus/types";
import type { Preset } from "@docusaurus/preset-classic";

const config: Config = {
  title: "Inferoa",
  tagline: "Inference-native Tokenmaxxing Agent Harness",
  favicon: "img/inferoa-favicon.svg",
  url: "https://inferoa.agentic-in.ai",
  baseUrl: "/",
  organizationName: "agentic-in",
  projectName: "inferoa",
  onBrokenLinks: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },
  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/agentic-in/inferoa/tree/main/website/",
        },
        blog: {
          showReadingTime: true,
          editUrl: "https://github.com/agentic-in/inferoa/tree/main/website/",
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  themes: ["@docusaurus/theme-mermaid"],
  themeConfig: {
    image: "img/inferoa-line-hero.png",
    navbar: {
      title: "Inferoa",
      items: [
        { to: "/docs/intro", label: "Docs", position: "left" },
        { to: "/blog", label: "Blog", position: "left" },
        {
          href: "https://github.com/agentic-in/inferoa",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Product",
          items: [
            { label: "Docs", to: "/docs/intro" },
            { label: "Announcement", to: "/blog/announcing-inferoa" },
          ],
        },
        {
          title: "Code",
          items: [
            { label: "GitHub", href: "https://github.com/agentic-in/inferoa" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Inferoa contributors.`,
    },
    prism: {
      theme: {
        plain: {
          color: "#d6dde8",
          backgroundColor: "#101419",
        },
        styles: [],
      },
      darkTheme: {
        plain: {
          color: "#d6dde8",
          backgroundColor: "#101419",
        },
        styles: [],
      },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
