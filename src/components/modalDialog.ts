import { useCallback, useEffect, useRef } from "react";

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
}

export function useModalDialog(options?: UseModalDialogOptions) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const isUnmountingRef = useRef(false);
  const isClosingProgrammaticallyRef = useRef(false);
  const onDismissRef = useRef(options?.onDismiss);

  useEffect(() => {
    onDismissRef.current = options?.onDismiss;
  }, [options?.onDismiss]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    isUnmountingRef.current = false;
    isClosingProgrammaticallyRef.current = false;
    dialog.returnValue = "";
    openModalDialog(dialog);
    return () => {
      isUnmountingRef.current = true;
      closeModalDialog(dialog);
    };
  }, []);

  const closeDialog = useCallback((returnValue?: string) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    isClosingProgrammaticallyRef.current = true;
    closeModalDialog(dialog, returnValue);
  }, []);

  const handleClose = useCallback(() => {
    if (isUnmountingRef.current || isClosingProgrammaticallyRef.current) {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog?.isConnected || dialog.open) return;
    if (onDismissRef.current) {
      dialog.returnValue = "";
      onDismissRef.current();
      return;
    }
    openModalDialog(dialog);
  }, []);

  return { dialogRef, closeDialog, handleClose };
}
