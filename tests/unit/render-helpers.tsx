import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// Thin react-dom helpers for component tests that only need to mount, click
// and press keys; tests that query by accessible role or name use
// @testing-library/react directly.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

export function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mounted.push({ root, container });
  return container;
}

export function unmountAll() {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

export function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function keyDown(
  key: string,
  target: EventTarget = window,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

export function byRole(root: ParentNode, role: string) {
  return Array.from(root.querySelectorAll<HTMLElement>(`[role="${role}"]`));
}

export function buttonByLabel(root: ParentNode, label: string) {
  const el = Array.from(root.querySelectorAll<HTMLElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!el) throw new Error(`no button labelled ${label}`);
  return el;
}

export async function settle(ms = 20) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

export async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met");
    await settle(5);
  }
}
