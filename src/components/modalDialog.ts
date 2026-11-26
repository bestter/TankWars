import { useCallback, useEffect, useRef, type SyntheticEvent } from "react";

export function openModalDialog(dialog: HTMLDialogElement): void {
  if (dialog.open || dialog.hasAttribute("open")) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

export function closeModalDialog(
  dialog: HTMLDialogElement,
  returnValue?: string,
): void {
  if (!dialog.open && !dialog.hasAttribute("open")) return;
  if (typeof dialog.close === "function") {
    if (returnValue !== undefined) {
      dialog.close(returnValue);
    } else {
      dialog.close();
    }
  } else {
    if (returnValue !== undefined) {
      dialog.returnValue = returnValue;
    }
    dialog.removeAttribute("open");
  }
}

export interface UseModalDialogOptions {
  readonly onDismiss?: () => void;
  readonly dismissActiveModals?: boolean;
}

interface ModalEntry {
  readonly dialog: HTMLDialogElement;
  readonly dismiss: () => void;
}

const activeModals = new Set<ModalEntry>();

export function useModalDialog({ onDismiss, dismissActiveModals = false }: UseModalDialogOptions = {}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const explicitlyClosedDialogRef = useRef<HTMLDialogElement | null>(null);
  const pendingCloseEventsRef = useRef<WeakMap<HTMLDialogElement, number> | null>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const closeWithoutDismiss = useCallback((dialog: HTMLDialogElement, returnValue?: string) => {
    if (!dialog.open && !dialog.hasAttribute("open")) return;
    if (typeof dialog.close === "function") {
      // Native close events are queued and can outlive a StrictMode effect replay.
      const pending = (pendingCloseEventsRef.current ??= new WeakMap<HTMLDialogElement, number>());
      pending.set(dialog, (pending.get(dialog) ?? 0) + 1);
    }
    closeModalDialog(dialog, returnValue);
  }, []);

  const closeDialog = useCallback((returnValue?: string) => {
    const dialog = dialogRef.current;
    if (!dialog || (!dialog.open && !dialog.hasAttribute("open"))) return;
    explicitlyClosedDialogRef.current = dialog;
    closeWithoutDismiss(dialog, returnValue);
  }, [closeWithoutDismiss]);

  // Dismiss before showModal so the browser can restore focus to the old invoker.
  useEffect(() => {
    if (!dismissActiveModals || !dialogRef.current) return;
    for (const entry of [...activeModals]) {
      if (entry.dialog !== dialogRef.current) entry.dismiss();
    }
  }, [dismissActiveModals]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const entry: ModalEntry = {
      dialog,
      dismiss: () => {
        const dismiss = onDismissRef.current;
        if (!dismiss || (!dialog.open && !dialog.hasAttribute("open"))) return;
        closeDialog();
        dismiss();
      },
    };
    activeModals.add(entry);
    // A dialog already dismissed by a sibling stays closed during StrictMode's replay.
    if (explicitlyClosedDialogRef.current !== dialog) {
      dialog.returnValue = "";
      openModalDialog(dialog);
    }
    return () => {
      activeModals.delete(entry);
      closeWithoutDismiss(dialog);
    };
  }, [closeDialog, closeWithoutDismiss]);

  const handleClose = useCallback((event: SyntheticEvent<HTMLDialogElement>) => {
    const dialog = event.currentTarget;
    if (event.target !== dialog) return;
    const pending = pendingCloseEventsRef.current;
    const count = pending?.get(dialog) ?? 0;
    if (pending && count > 0) {
      if (count === 1) pending.delete(dialog);
      else pending.set(dialog, count - 1);
      return;
    }
    if (dialog !== dialogRef.current || !dialog.isConnected || dialog.open) return;
    if (onDismissRef.current) {
      dialog.returnValue = "";
      onDismissRef.current();
      return;
    }
    openModalDialog(dialog);
  }, []);

  return { dialogRef, closeDialog, handleClose };
}
