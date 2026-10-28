import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type InertNode = { inert: boolean };
type Isolation = {
  owners: number;
  restore: () => void;
  drain: () => void;
  observer?: MutationObserver;
};
const isolations = new WeakMap<InertNode, Isolation>();

// Shared leases also observe legacy/auth writers that do not use this helper.
// Drain before every owned write/release: even same-value writes in this tick
// represent external ownership. Our own mutations are consumed synchronously.
export function isolateBackground(nodes: InertNode[]) {
  const leases = [...new Set(nodes)].map((node) => {
    let state = isolations.get(node);
    if (!state) {
      const element = typeof HTMLElement !== "undefined" && node instanceof HTMLElement
        ? node : null;
      const original = node.inert;
      let attribute = element?.getAttribute("inert") ?? null;
      state = { owners: 0, drain: () => {}, restore: () => { node.inert = original; } };
      const current = state;
      if (element) {
        const write = (value: string | null) => {
          if (value === null) element.removeAttribute("inert");
          else element.setAttribute("inert", value);
          current.observer?.takeRecords();
        };
        const observe = (records: MutationRecord[]) => {
          if (!records.length) return;
          attribute = element.getAttribute("inert");
          if (current.owners && attribute === null) write("");
        };
        current.observer = new MutationObserver(observe);
        current.observer.observe(element, { attributes: true, attributeFilter: ["inert"] });
        current.drain = () => observe(current.observer!.takeRecords());
        current.restore = () => write(attribute);
        // Install isolation only after the observer exists, consuming our write.
        write(attribute ?? "");
      } else node.inert = true;
      isolations.set(node, current);
    }
    state.drain();
    state.owners++;
    return { node, state };
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const { node, state } of leases) {
      state.drain();
      if (--state.owners) continue;
      state.observer?.disconnect();
      state.restore();
      isolations.delete(node);
    }
  };
}
export function StatsModal({
  children,
  label,
  testId,
  onCancel,
  onReady,
}: {
  children: ReactNode;
  label: string;
  testId: string;
  onCancel: () => void;
  onReady?: (release: () => void) => void;
}) {
  const [host] = useState(() => document.createElement("div"));
  const panel = useRef<HTMLElement>(null);
  const callbacks = useRef({ onCancel, onReady });
  callbacks.current = { onCancel, onReady };
  useLayoutEffect(() => {
    host.className = "stats-modal-root";
    const source = document.querySelector('[data-testid="watercolor-stats"]');
    if (source) {
      const tokens = getComputedStyle(source);
      for (const name of [
        "--paper",
        "--ink",
        "--muted",
        "--lake",
        "--line",
        "--font-hand",
      ]) {
        const value = tokens.getPropertyValue(name);
        if (value.trim()) host.style.setProperty(name, value);
      }
    }
    document.body.append(host);
    // Direct body siblings include the whole current application and its bottom navigation.
    const roots = Array.from(document.body.children).filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement &&
        node !== host &&
        !["SCRIPT", "STYLE", "LINK"].includes(node.tagName),
    );
    const restore = isolateBackground(roots);
    let live = true;
    const focusable = () =>
      Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter(
        (node) =>
          !node.hidden &&
          !node.closest("[hidden], [inert]") &&
          node.getClientRects().length > 0,
      );
    const focusFirst = () => (focusable()[0] ?? panel.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        callbacks.current.onCancel();
      }
      if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) {
          event.preventDefault();
          panel.current?.focus();
          return;
        }
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (
          index === -1 ||
          (!event.shiftKey && index === items.length - 1) ||
          (event.shiftKey && index === 0)
        ) {
          event.preventDefault();
          (event.shiftKey ? items[items.length - 1] : items[0]).focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (live && !host.contains(event.target as Node)) focusFirst();
    };
    const release = () => {
      if (!live) return;
      live = false;
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin, true);
      restore();
      host.remove();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    callbacks.current.onReady?.(release);
    focusFirst();
    return release;
  }, [host]);
  return createPortal(
    <div
      className="stats-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={panel}
        className="stats-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
      >
        {children}
      </section>
    </div>,
    host,
  );
}
