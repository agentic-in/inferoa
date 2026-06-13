import test from "node:test";
import assert from "node:assert/strict";
import * as appModule from "../src/tui/app.js";
import { SLASH_COMMANDS } from "../src/tui/slash.js";

type SelectOptionWindow = <T>(options: readonly T[], selected: number, pageSize: number) => {
  items: T[];
  pageIndex: number;
  totalPages: number;
};

type MoveSelectOptionPage = (selected: number, totalItems: number, pageSize: number, delta: number) => number;
type SelectOption = { value: string; label: string; description?: string };
type GoalSetupChoiceState = { selectedIndex: number };
type ApplyGoalSetupChoiceToken = <T extends string>(
  state: GoalSetupChoiceState,
  options: Array<SelectOption & { value: T }>,
  key: string,
) => {
  state: GoalSetupChoiceState;
  value?: T;
  cancelled?: boolean;
};
type RenderGoalSetupChoicePanel = <T extends string>(
  title: string,
  options: Array<SelectOption & { value: T }>,
  selectedIndex: number,
  footer?: string[],
  width?: number,
  context?: unknown,
) => string[];

test("slash command picker pagination can reveal doctor command", () => {
  const selectOptionWindow = (appModule as Record<string, unknown>).selectOptionWindow as SelectOptionWindow | undefined;
  const moveSelectOptionPage = (appModule as Record<string, unknown>).moveSelectOptionPage as MoveSelectOptionPage | undefined;
  if (typeof selectOptionWindow !== "function") {
    assert.fail("selectOptionWindow export is required");
  }
  if (typeof moveSelectOptionPage !== "function") {
    assert.fail("moveSelectOptionPage export is required");
  }

  const commands = SLASH_COMMANDS.map((command) => `/${command.name}`);
  const firstPage = selectOptionWindow(commands, 0, 12);
  assert.equal(firstPage.pageIndex, 0);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.items.includes("/doctor"), false);

  const secondPageIndex = moveSelectOptionPage(0, commands.length, 12, 1);
  const secondPage = selectOptionWindow(commands, secondPageIndex, 12);
  assert.equal(secondPage.pageIndex, 1);
  assert.equal(secondPage.items.includes("/doctor"), true);
});

test("loop setup choices use arrow navigation and enter selection", () => {
  const applyGoalSetupChoiceToken = (appModule as Record<string, unknown>).applyGoalSetupChoiceToken as ApplyGoalSetupChoiceToken | undefined;
  if (typeof applyGoalSetupChoiceToken !== "function") {
    assert.fail("applyGoalSetupChoiceToken export is required");
  }
  const options = [
    { value: "deliver", label: "Deliver", description: "Close the objective." },
    { value: "discover", label: "Discover", description: "Learn with evidence." },
    { value: "replay", label: "Replay", description: "Repeat the prompt." },
  ] as const;

  let result = applyGoalSetupChoiceToken({ selectedIndex: 0 }, options.slice(), "\u001b[B");
  assert.equal(result.state.selectedIndex, 1);
  assert.equal(result.value, undefined);

  result = applyGoalSetupChoiceToken(result.state, options.slice(), "\u001b[B");
  assert.equal(result.state.selectedIndex, 2);

  result = applyGoalSetupChoiceToken(result.state, options.slice(), "\r");
  assert.equal(result.value, "replay");
});

test("loop setup choice panel renders selected row without numeric input affordance", () => {
  const renderGoalSetupChoicePanel = (appModule as Record<string, unknown>).renderGoalSetupChoicePanel as RenderGoalSetupChoicePanel | undefined;
  if (typeof renderGoalSetupChoicePanel !== "function") {
    assert.fail("renderGoalSetupChoicePanel export is required");
  }
  const lines = renderGoalSetupChoicePanel(
    "Runtime",
    [
      { value: "auto", label: "Auto", description: "Inferoa picks the checkpoint time." },
      { value: "24h", label: "24h", description: "Run for at least 24h." },
    ],
    1,
    [],
    100,
  );
  const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  assert.match(plain, /↑\/↓ choose · enter select · esc cancels/);
  assert.match(plain, /› 24h · 24h · selected · Run for at least 24h\./);
  assert.doesNotMatch(plain, /type a value or number|1\.|2\./);
});

test("loop setup choice panel keeps wizard height stable across steps", () => {
  const renderGoalSetupChoicePanel = (appModule as Record<string, unknown>).renderGoalSetupChoicePanel as RenderGoalSetupChoicePanel | undefined;
  if (typeof renderGoalSetupChoicePanel !== "function") {
    assert.fail("renderGoalSetupChoicePanel export is required");
  }
  const commonContext = {
    objective: "Improve cache observability",
    steps: ["Preference", "Runtime", "Human in the Loop", "Review"],
  };
  const typeLines = renderGoalSetupChoicePanel(
    "Preference",
    [
      { value: "deliver", label: "Deliver", description: "Close the loop end to end." },
      { value: "discover", label: "Discover", description: "Metric-driven research." },
    ],
    0,
    [],
    100,
    { ...commonContext, currentStep: "Preference" },
  );
  const reviewLines = renderGoalSetupChoicePanel(
    "Start Loop",
    [{ value: "start", label: "Start", description: "Create the loop." }],
    0,
    [],
    100,
    {
      ...commonContext,
      currentStep: "Review",
      selections: { preference: "Discover", runtime: "Auto", hil: "Review" },
      hint: "enter start · esc cancels",
    },
  );
  const plainReview = reviewLines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  assert.equal(typeLines.length, reviewLines.length);
  assert.match(plainReview, /Preference .*Runtime .*Human in the Loop .*Review/);
  assert.match(plainReview, /goal\s+Improve cache observability/);
  assert.match(plainReview, /preference\s+Discover/);
  assert.match(plainReview, /runtime\s+Auto/);
  assert.match(plainReview, /human\s+Review/);
  assert.doesNotMatch(plainReview, /pref…|runt…/);
  assert.match(plainReview, /enter start · esc cancels/);
});
