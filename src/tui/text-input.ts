import { visibleWidth } from "./ansi.js";

export interface TextInputState {
  value: string;
  cursor: number;
}

export interface TextInputDisplay {
  beforeCursor: string;
  afterCursor: string;
}

export function createTextInputState(value = ""): TextInputState {
  return { value, cursor: value.length };
}

export function applyTextInputToken(state: TextInputState, token: string): TextInputState {
  if (token === "\u001b[D") {
    return { ...state, cursor: previousCharBoundary(state.value, state.cursor) };
  }
  if (token === "\u001b[C") {
    return { ...state, cursor: nextCharBoundary(state.value, state.cursor) };
  }
  if (token === "\u001b[H" || token === "\u001b[1~") {
    return { ...state, cursor: 0 };
  }
  if (token === "\u001b[F" || token === "\u001b[4~") {
    return { ...state, cursor: state.value.length };
  }
  if (token === "\u007f") {
    const start = previousCharBoundary(state.value, state.cursor);
    if (start === state.cursor) {
      return state;
    }
    return {
      value: `${state.value.slice(0, start)}${state.value.slice(state.cursor)}`,
      cursor: start,
    };
  }
  if (token.startsWith("\u001b")) {
    return state;
  }
  const printable = printableText(token);
  if (!printable) {
    return state;
  }
  return {
    value: `${state.value.slice(0, state.cursor)}${printable}${state.value.slice(state.cursor)}`,
    cursor: state.cursor + printable.length,
  };
}

export function renderTextInputDisplay(state: TextInputState, width: number, options: { secret?: boolean } = {}): TextInputDisplay {
  const safeWidth = Math.max(1, width);
  const valueChars = Array.from(state.value);
  const displayChars = Array.from(options.secret ? "•".repeat(valueChars.length) : state.value);
  const cursorIndex = charIndexForCursor(state.value, state.cursor);
  const viewport = inputViewport(displayChars, cursorIndex, safeWidth);
  return {
    beforeCursor: displayChars.slice(viewport.start, cursorIndex).join(""),
    afterCursor: displayChars.slice(cursorIndex, viewport.end).join(""),
  };
}

function printableText(value: string): string {
  return [...value].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && code !== 0x1b;
  }).join("");
}

function previousCharBoundary(buffer: string, cursor: number): number {
  let previous = 0;
  for (const boundary of charBoundaries(buffer)) {
    if (boundary >= cursor) {
      return previous;
    }
    previous = boundary;
  }
  return previous;
}

function nextCharBoundary(buffer: string, cursor: number): number {
  for (const boundary of charBoundaries(buffer)) {
    if (boundary > cursor) {
      return boundary;
    }
  }
  return buffer.length;
}

function charIndexForCursor(buffer: string, cursor: number): number {
  const boundaries = charBoundaries(buffer);
  const exact = boundaries.indexOf(cursor);
  if (exact >= 0) {
    return exact;
  }
  const next = boundaries.findIndex((boundary) => boundary > cursor);
  return next >= 0 ? next : boundaries.length - 1;
}

function charBoundaries(buffer: string): number[] {
  const boundaries = [0];
  let offset = 0;
  for (const char of buffer) {
    offset += char.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function inputViewport(chars: string[], cursorIndex: number, width: number): { start: number; end: number } {
  let start = 0;
  while (start < cursorIndex && visibleWidth(chars.slice(start, cursorIndex).join("")) > Math.max(0, width - 1)) {
    start += 1;
  }

  let end = cursorIndex;
  let out = chars.slice(start, cursorIndex).join("");
  while (end < chars.length) {
    const next = `${out}${chars[end]}`;
    if (visibleWidth(next) > width) {
      break;
    }
    out = next;
    end += 1;
  }
  return { start, end };
}
