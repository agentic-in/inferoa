import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Overview",
      collapsed: false,
      items: ["intro", "architecture"],
    },
    {
      type: "category",
      label: "Start",
      collapsed: false,
      items: ["quickstart", "getting-started/installation", "getting-started/first-session"],
    },
    {
      type: "category",
      label: "Core Concepts",
      collapsed: false,
      items: ["concepts/tokenmaxxing", "concepts/context-optimization", "concepts/prefix-cache"],
    },
    {
      type: "category",
      label: "Workflows",
      collapsed: false,
      items: ["workflows/goal-mode", "workflows/plan-mode", "workflows/autoresearch-mode", "workflows/coding-workflow", "workflows/daemon-jobs"],
    },
    {
      type: "category",
      label: "Configure",
      collapsed: false,
      items: ["configuration/model-endpoints", "configuration/omni", "configuration/context-and-rtk"],
    },
    {
      type: "category",
      label: "Operate",
      collapsed: false,
      items: ["operations/acceptance", "operations/evidence-and-sessions"],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: ["reference/cli", "reference/slash-commands", "reference/configuration"],
    },
  ],
};

export default sidebars;
