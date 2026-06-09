import { ansi, fg256, padRight, truncateToWidth, visibleWidth } from "./ansi.js";

export interface HomeRenderOptions {
  workspaceRoot: string;
  mode: string;
  model: string;
  width: number;
}

export function renderHomeFrame(options: HomeRenderOptions): string[] {
  const frameWidth = Math.max(20, options.width);
  const inner = frameWidth - 2;
  if (frameWidth < 84) {
    return homeFrame("", [...renderHomeLeft(options, inner), "", ...renderHomeTips(inner)], frameWidth);
  }
  const leftWidth = Math.min(48, Math.max(34, Math.floor(inner * 0.42)));
  const rightWidth = inner - leftWidth - 3;
  const left = renderHomeLeft(options, leftWidth);
  const right = renderHomeTips(rightWidth);
  const body = mergeHomeColumns(left, right, leftWidth, rightWidth);
  return homeFrame("", body, frameWidth);
}

function renderHomeLeft(options: HomeRenderOptions, width: number): string[] {
  const status = `${fg256(250, modeLabel(options.mode))} ${fg256(244, "·")} ${fg256(39, options.model)}`;
  return [
    centerHome(`${ansi.bold}Welcome back!${ansi.reset}`, width),
    "",
    ...renderInferoaWordmark().map((line) => centerHome(line, width)),
    "",
    centerHome(fg256(244, truncateToWidth(compactPath(options.workspaceRoot), width)), width),
    centerHome(fg256(244, truncateToWidth(status, width)), width),
  ];
}

function renderHomeTips(width: number): string[] {
  return [
    `${ansi.bold}${fg256(39, "Tips for getting started")}${ansi.reset}`,
    `${fg256(39, "/")} ${fg256(250, "commands")}`,
    `${fg256(39, "$")} ${fg256(250, "skills")}`,
    `${fg256(39, "Esc")} ${fg256(250, "interrupt the active loop")}`,
  ].map((line) => truncateToWidth(line, width));
}

function renderInferoaWordmark(): string[] {
  const main = `${fg256(244, ">_")} ${ansi.bold}${fg256(252, "Infer")}${fg256(31, "oa")}${ansi.reset}`;
  const sub = `${fg256(244, "Inference-native Tokenmaxxing Agent Harness")}`;
  return [
    main,
    sub,
  ];
}

function homeFrame(title: string, body: string[], width: number): string[] {
  const inner = width - 2;
  if (!title.trim()) {
    const border = (text: string) => fg256(39, text);
    const muted = (text: string) => fg256(238, text);
    return [
      `${border("╭")}${muted("─".repeat(inner))}${border("╮")}`,
      ...body.map((line) => `${border("│")}${padRight(line, inner)}${border("│")}`),
      `${border("╰")}${muted("─".repeat(inner))}${border("╯")}`,
    ];
  }
  const cleanTitle = ` ${truncateToWidth(title, Math.max(4, inner - 2))} `;
  const left = Math.max(0, Math.floor((inner - visibleWidth(cleanTitle)) / 2));
  const right = Math.max(0, inner - left - visibleWidth(cleanTitle));
  const border = (text: string) => fg256(39, text);
  const muted = (text: string) => fg256(238, text);
  return [
    `${border("╭")}${muted("─".repeat(left))}${ansi.bold}${fg256(252, cleanTitle)}${ansi.reset}${muted("─".repeat(right))}${border("╮")}`,
    ...body.map((line) => `${border("│")}${padRight(line, inner)}${border("│")}`),
    `${border("╰")}${muted("─".repeat(inner))}${border("╯")}`,
  ];
}

function mergeHomeColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  const rows = Math.max(left.length, right.length);
  const divider = fg256(238, "│");
  return Array.from({ length: rows }, (_, index) => {
    const leftLine = padRight(left[index] ?? "", leftWidth);
    const rightLine = padRight(right[index] ?? "", rightWidth);
    return `${leftLine} ${divider} ${rightLine}`;
  });
}

function centerHome(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  const padding = Math.max(0, width - visibleWidth(clipped));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
}

function compactPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function modeLabel(mode: string): string {
  if (mode === "direct") {
    return "vLLM native";
  }
  return mode;
}
