export interface ComposerInputHistory {
  entries: string[];
  limit: number;
}

export interface ComposerInputHistoryNavigation {
  index: number;
  draft: string;
}

export type ComposerInputHistoryDirection = "previous" | "next";

export interface ComposerInputHistoryNavigationResult {
  buffer: string;
  cursor: number;
  navigation?: ComposerInputHistoryNavigation;
  changed: boolean;
}

const DEFAULT_HISTORY_LIMIT = 100;

export function createComposerInputHistory(limit = DEFAULT_HISTORY_LIMIT): ComposerInputHistory {
  return {
    entries: [],
    limit: Math.max(1, Math.floor(limit)),
  };
}

export function recordComposerInputHistoryEntry(
  history: ComposerInputHistory,
  entry: string,
): ComposerInputHistory {
  if (!entry.trim()) {
    return history;
  }
  if (history.entries.at(-1) === entry) {
    return history;
  }
  const entries = [...history.entries, entry].slice(-history.limit);
  return { ...history, entries };
}

export function navigateComposerInputHistory(
  history: ComposerInputHistory,
  navigation: ComposerInputHistoryNavigation | undefined,
  direction: ComposerInputHistoryDirection,
  currentBuffer: string,
): ComposerInputHistoryNavigationResult {
  if (!history.entries.length) {
    return unchanged(currentBuffer, navigation);
  }

  if (direction === "previous") {
    const nextIndex = navigation === undefined
      ? history.entries.length - 1
      : Math.max(0, navigation.index - 1);
    const nextBuffer = history.entries[nextIndex] ?? currentBuffer;
    return {
      buffer: nextBuffer,
      cursor: nextBuffer.length,
      navigation: { index: nextIndex, draft: navigation?.draft ?? currentBuffer },
      changed: nextBuffer !== currentBuffer,
    };
  }

  if (navigation === undefined) {
    return unchanged(currentBuffer, navigation);
  }

  const nextIndex = navigation.index + 1;
  if (nextIndex >= history.entries.length) {
    return {
      buffer: navigation.draft,
      cursor: navigation.draft.length,
      changed: navigation.draft !== currentBuffer,
    };
  }

  const nextBuffer = history.entries[nextIndex] ?? currentBuffer;
  return {
    buffer: nextBuffer,
    cursor: nextBuffer.length,
    navigation: { ...navigation, index: nextIndex },
    changed: nextBuffer !== currentBuffer,
  };
}

function unchanged(
  buffer: string,
  navigation: ComposerInputHistoryNavigation | undefined,
): ComposerInputHistoryNavigationResult {
  return {
    buffer,
    cursor: buffer.length,
    navigation,
    changed: false,
  };
}
