declare module 'blessed-contrib' {
  import type { Widgets } from 'blessed';

  interface GridOptions {
    rows: number;
    cols: number;
    screen: Widgets.Screen;
  }

  interface TableOptions {
    keys?: boolean;
    fg?: string;
    selectedFg?: string;
    selectedBg?: string;
    interactive?: boolean;
    label?: string;
    width?: string | number;
    height?: string | number;
    border?: { type: string; fg: string };
    columnSpacing?: number;
    columnWidth?: number[];
  }

  interface ListOptions {
    keys?: boolean;
    vi?: boolean;
    fg?: string;
    label?: string;
    border?: { type: string; fg: string };
    width?: string | number;
    height?: string | number;
    style?: Record<string, unknown>;
    padding?: number;
  }

  interface TextOptions {
    content?: string;
    label?: string;
    fg?: string;
    border?: { type: string; fg: string };
    width?: string | number;
    height?: string | number;
    style?: Record<string, unknown>;
    padding?: { left?: number; right?: number; top?: number; bottom?: number };
  }

  interface LogOptions {
    fg?: string;
    selectedFg?: string;
    label?: string;
    height?: string | number;
    width?: string | number;
    border?: { type: string; fg: string };
    scrollable?: boolean;
    mouse?: boolean;
    tags?: boolean;
    style?: Record<string, unknown>;
    padding?: number;
  }

  interface ContribTable {
    setData(data: { headers: string[]; data: string[][] }): void;
    focus(): void;
  }

  interface ContribLog extends Widgets.Log {
    log(text: string): void;
  }

  interface ContribText extends Widgets.BoxElement {
    setContent(text: string): void;
  }

  interface ContribList extends Widgets.ListElement {
    setItems(items: string[]): void;
  }

  class grid {
    constructor(options: GridOptions);
    set<T>(row: number, col: number, rowSpan: number, colSpan: number, widget: unknown, options?: unknown): T;
  }

  const table: unknown;
  const log: unknown;
}
