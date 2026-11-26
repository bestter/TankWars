// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalDialog, type UseModalDialogOptions } from "../modalDialog";

function TestDialog({ id, ...options }: UseModalDialogOptions & { id: string }) {
  const { dialogRef, closeDialog, handleClose } = useModalDialog(options);
  return (
    <dialog ref={dialogRef} aria-label={id} onClose={handleClose}>
      <button type="button" onClick={() => closeDialog("confirm")}>Close</button>
    </dialog>
  );
}

describe("useModalDialog", () => {
  let queuedCloses: HTMLDialogElement[];
  const prototype = HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(prototype, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(prototype, "close");

  beforeEach(() => {
    queuedCloses = [];
    Object.defineProperty(prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement, returnValue?: string) {
        if (!this.open) return;
        this.open = false;
        if (returnValue !== undefined) this.returnValue = returnValue;
        queuedCloses.push(this);
      },
    });
  });

  afterEach(() => {
    cleanup();
    if (originalShow) Object.defineProperty(prototype, "showModal", originalShow);
    else Reflect.deleteProperty(prototype, "showModal");
    if (originalClose) Object.defineProperty(prototype, "close", originalClose);
    else Reflect.deleteProperty(prototype, "close");
  });

  function flushCloseEvents() {
    for (const dialog of queuedCloses.splice(0)) {
      fireEvent(dialog, new Event("close"));
    }
  }

  it("combines both options and dismisses exactly once during a StrictMode replay", () => {
    const onFirstDismiss = vi.fn();
    const onSecondDismiss = vi.fn();
    const { container, getByRole } = render(
      <StrictMode>
        <TestDialog id="first" onDismiss={onFirstDismiss} />
        <TestDialog id="second" onDismiss={onSecondDismiss} dismissActiveModals />
      </StrictMode>,
    );

    flushCloseEvents();
    expect(onFirstDismiss).toHaveBeenCalledOnce();
    expect(onSecondDismiss).not.toHaveBeenCalled();
    expect(container.querySelectorAll("dialog[open]")).toHaveLength(1);

    const second = getByRole("dialog", { name: "second" }) as HTMLDialogElement;
    fireEvent.click(getByRole("button", { name: "Close" }));
    expect(second.returnValue).toBe("confirm");
    second.showModal();
    act(() => second.close());
    flushCloseEvents();
    expect(onSecondDismiss).toHaveBeenCalledOnce();
  });

  it("uses the current dismiss callback without reopening the dialog", () => {
    const onDismiss = vi.fn();
    const { rerender, getByRole } = render(<TestDialog id="first" />);
    const first = getByRole("dialog", { name: "first" }) as HTMLDialogElement;
    first.returnValue = "preserved";
    rerender(<TestDialog id="first" onDismiss={onDismiss} />);
    expect(first.returnValue).toBe("preserved");
    expect(queuedCloses).toHaveLength(0);
    rerender(
      <>
        <TestDialog id="first" onDismiss={onDismiss} />
        <TestDialog id="second" dismissActiveModals />
      </>,
    );
    flushCloseEvents();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(getByRole("dialog", { name: "second" })).toBeDefined();
  });
});
