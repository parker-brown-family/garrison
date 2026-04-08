import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export type WorkflowAction = "assess" | "new" | "update" | "status" | "help" | "exit";

export interface NotebookListItem {
  name: string;
  sourceCount?: number;
  updatedAt?: string;
}

export interface WorkflowHandlers {
  assess(link: string): Promise<void>;
  createNotebook(name: string, link: string): Promise<void>;
  updateNotebook(name: string): Promise<void>;
  showStatus(): Promise<void>;
  showHelp(): void | Promise<void>;
  getNotebookList(): Promise<NotebookListItem[]>;
}

export interface WorkflowSession {
  prompt(question: string): Promise<string>;
  write(message: string): void;
  close(): void;
}

const WORKFLOW_OPTIONS: Array<{ key: string; action: WorkflowAction; label: string }> = [
  { key: "1", action: "assess", label: "Assess a NotebookLM link (read-only)" },
  { key: "2", action: "new", label: "Create a new notebook" },
  { key: "3", action: "update", label: "Update an existing notebook" },
  { key: "4", action: "status", label: "Show notebook status" },
  { key: "5", action: "help", label: "Show CLI help" },
  { key: "6", action: "exit", label: "Exit" },
];

export function createWorkflowSession(): WorkflowSession {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    prompt(question: string) {
      return rl.question(question);
    },
    write(message: string) {
      stdout.write(message);
    },
    close() {
      rl.close();
    },
  };
}

export function renderWorkflowMenu(): string {
  const lines = [
    "Garrison Workflow Launcher",
    "",
    ...WORKFLOW_OPTIONS.map((option) => `${option.key}) ${option.label}`),
    "",
  ];
  return lines.join("\n");
}

export function parseWorkflowSelection(input: string): WorkflowAction | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;

  const option = WORKFLOW_OPTIONS.find((candidate) => candidate.key === normalized);
  if (option) return option.action;

  switch (normalized) {
    case "assess":
      return "assess";
    case "new":
    case "create":
      return "new";
    case "update":
      return "update";
    case "status":
      return "status";
    case "help":
      return "help";
    case "exit":
    case "quit":
      return "exit";
    default:
      return null;
  }
}

const PAGE_SIZE = 10;

function writeLine(session: WorkflowSession, message = ""): void {
  session.write(`${message}\n`);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderNotebookPage(
  items: NotebookListItem[],
  page: number,
  totalPages: number
): string {
  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  const nameWidth = Math.max(...slice.map((i) => i.name.length), 4);
  const divider = "─".repeat(nameWidth + 26);

  const lines: string[] = [
    "Select notebook to update",
    divider,
  ];

  slice.forEach((item, idx) => {
    const num = String(idx + 1).padStart(2);
    const name = item.name.padEnd(nameWidth);
    const src =
      item.sourceCount != null
        ? String(item.sourceCount).padStart(3) + " src"
        : "       ";
    const date = item.updatedAt ? item.updatedAt.slice(0, 10) : "          ";
    lines.push(`  ${num}.  ${name}   ${src}   ${date}`);
  });

  lines.push(divider);

  const canNext = page < totalPages - 1;
  const canPrev = page > 0;
  const navParts: string[] = [];
  if (canNext) navParts.push("[n] next");
  if (canPrev) navParts.push("[l] last");
  navParts.push("[q] cancel");

  lines.push(`Page ${page + 1} / ${totalPages}   ${navParts.join("   ")}`);
  lines.push("");

  return lines.join("\n");
}

async function pickNotebookFromList(
  items: NotebookListItem[],
  session: WorkflowSession
): Promise<string | null> {
  if (items.length === 0) {
    writeLine(session, "No notebooks registered. Use option 2 to create one first.");
    return null;
  }

  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  let page = 0;

  while (true) {
    writeLine(session, renderNotebookPage(items, page, totalPages));

    const raw = (await session.prompt("Enter number or command: ")).trim().toLowerCase();

    if (raw === "q" || raw === "cancel") {
      writeLine(session, "Cancelled.");
      return null;
    }

    if (raw === "n" || raw === "next") {
      if (page < totalPages - 1) {
        page++;
      } else {
        writeLine(session, "Already on the last page.");
      }
      continue;
    }

    if (raw === "l" || raw === "last") {
      if (page > 0) {
        page--;
      } else {
        writeLine(session, "Already on the first page.");
      }
      continue;
    }

    const num = parseInt(raw, 10);
    const start = page * PAGE_SIZE;
    const pageCount = Math.min(PAGE_SIZE, items.length - start);

    if (!isNaN(num) && num >= 1 && num <= pageCount) {
      return items[start + num - 1].name;
    }

    writeLine(
      session,
      `Invalid input. Enter 1-${pageCount}, [n]ext, [l]ast, or [q]uit.`
    );
  }
}

export async function runWorkflowLauncher(
  handlers: WorkflowHandlers,
  session: WorkflowSession
): Promise<void> {
  writeLine(session, "No command provided. Starting guided workflow.");
  writeLine(session);

  while (true) {
    let action: WorkflowAction | null = null;
    while (action === null) {
      writeLine(session, renderWorkflowMenu());
      action = parseWorkflowSelection(await session.prompt("Select an option [1-6]: "));
      if (action === null) {
        writeLine(session, 'Invalid selection. Enter 1-6 or a command name such as "status".');
        writeLine(session);
      }
    }

    try {
      switch (action) {
        case "assess": {
          const link = (await session.prompt("NotebookLM link: ")).trim();
          if (!link) {
            writeLine(session, "NotebookLM link is required. Aborted.");
            break;
          }
          await handlers.assess(link);
          break;
        }
        case "new": {
          const name = (await session.prompt("Notebook name: ")).trim();
          const link = (await session.prompt("NotebookLM link: ")).trim();
          if (!name || !link) {
            writeLine(session, "Notebook name and NotebookLM link are required. Aborted.");
            break;
          }
          await handlers.createNotebook(name, link);
          break;
        }
        case "update": {
          const list = await handlers.getNotebookList();
          const name = await pickNotebookFromList(list, session);
          if (!name) break;
          await handlers.updateNotebook(name);
          break;
        }
        case "status":
          await handlers.showStatus();
          break;
        case "help":
          await handlers.showHelp();
          break;
        case "exit":
          writeLine(session, "Exiting.");
          return;
      }
    } catch (error) {
      writeLine(session, "Operation failed:");
      writeLine(session, formatErrorMessage(error));
    }

    writeLine(session);
    writeLine(session, "Returning to workflow menu.");
    writeLine(session);
  }
}