// @ts-ignore — blessed-contrib has no official types; we use a minimal local stub
import contrib from 'blessed-contrib';
import blessed from 'blessed';
import type { DashboardData } from './data.js';
import { formatAge } from './data.js';

const PROMPT_MAX = 40;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export interface DashboardScreen {
  screen: blessed.Widgets.Screen;
  render(data: DashboardData): void;
  log(text: string): void;
  destroy(): void;
}

export function createDashboard(): DashboardScreen {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'coord dashboard',
  });

  // 2x2 grid
  const grid = new contrib.grid({ rows: 2, cols: 2, screen });

  // Top-left: Agents table
  const agentsTable = grid.set(0, 0, 1, 1, contrib.table, {
    keys: true,
    fg: 'white',
    selectedFg: 'white',
    selectedBg: 'blue',
    interactive: true,
    label: ' Agents ',
    border: { type: 'line', fg: 'cyan' },
    columnSpacing: 2,
    columnWidth: [16, 8, 10, 8, 8, 10],
  }) as {
    setData(d: { headers: string[]; data: string[][] }): void;
    focus(): void;
  };

  // Top-right: Tasks list
  const tasksList = grid.set(0, 1, 1, 1, contrib.table, {
    keys: true,
    fg: 'white',
    selectedFg: 'white',
    selectedBg: 'blue',
    interactive: true,
    label: ' Tasks ',
    border: { type: 'line', fg: 'cyan' },
    columnSpacing: 2,
    columnWidth: [10, 10, 10, PROMPT_MAX + 2, 6],
  }) as {
    setData(d: { headers: string[]; data: string[][] }): void;
    focus(): void;
  };

  // Bottom-left: Stats box
  const statsBox = grid.set(1, 0, 1, 1, blessed.box, {
    label: ' Stats ',
    border: { type: 'line', fg: 'cyan' },
    fg: 'white',
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    tags: true,
  }) as blessed.Widgets.BoxElement;

  // Bottom-right: Log panel
  const logPanel = grid.set(1, 1, 1, 1, contrib.log, {
    fg: 'green',
    selectedFg: 'green',
    label: ' Events ',
    border: { type: 'line', fg: 'cyan' },
    scrollable: true,
    mouse: true,
    tags: true,
    style: { scrollbar: { bg: 'blue' } },
    padding: 0,
  }) as { log(text: string): void } & blessed.Widgets.Log;

  // Keyboard bindings
  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key(['tab'], () => {
    screen.focusNext();
    screen.render();
  });

  // Initial focus
  (agentsTable as unknown as { focus(): void }).focus();
  screen.render();

  function render(data: DashboardData): void {
    // Agents table
    const agentRows = data.agents.map((a) => [
      a.name,
      a.status,
      a.os + '/' + a.arch,
      String(a.currentTaskIds.length),
      String(a.maxConcurrent),
      a.health
        ? (a.health.claudeAvailable ? '{green-fg}ok{/green-fg}' : '{red-fg}down{/red-fg}')
        : 'unknown',
    ]);
    agentsTable.setData({
      headers: ['Name', 'Status', 'Platform', 'Active', 'Max', 'Health'],
      data: agentRows.length > 0 ? agentRows : [['(none)', '', '', '', '', '']],
    });

    // Tasks table — show up to 50 most recent
    const recent = data.tasks
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);

    const taskRows = recent.map((t) => [
      t.id.slice(0, 8),
      t.agentName,
      t.status,
      truncate(t.prompt, PROMPT_MAX),
      formatAge(t.createdAt),
    ]);
    tasksList.setData({
      headers: ['ID', 'Agent', 'Status', 'Prompt', 'Age'],
      data: taskRows.length > 0 ? taskRows : [['(none)', '', '', '', '']],
    });

    // Stats bar
    const s = data.stats;
    const statsLines = [
      `{bold}Queue Depth:{/bold}    ${s.queueDepth}`,
      `{bold}Active Tasks:{/bold}   ${s.activeTasks}`,
      `{bold}Completed:{/bold}      ${s.completedTasks}`,
      `{bold}Errored:{/bold}        ${s.erroredTasks}`,
      `{bold}Agents Online:{/bold}  ${s.connectedAgents}`,
    ].join('\n');
    statsBox.setContent(statsLines);

    screen.render();
  }

  function log(text: string): void {
    const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
    logPanel.log(`{grey-fg}${ts}{/grey-fg} ${text}`);
    screen.render();
  }

  function destroy(): void {
    screen.destroy();
  }

  return { screen, render, log, destroy };
}
