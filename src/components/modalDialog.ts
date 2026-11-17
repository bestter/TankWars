import { useEffect, useRef } from "react";

export function openModalDialog(dialog: HTMLDialogElement): void {
  if (dialog.open || dialog.hasAttribute("open")) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

export function closeModalDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open && !dialog.hasAttribute("open")) return;
  if (typeof dialog.close === "function") {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

export function useModalDialog() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const isUnmountingRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    isUnmountingRef.current = false;
    openModalDialog(dialog);
    return () => {
      isUnmountingRef.current = true;
      closeModalDialog(dialog);
    };
  }, []);

  const handleClose = () => {
    if (!isUnmountingRef.current && dialogRef.current?.isConnected) {
      openModalDialog(dialogRef.current);
    }
  };

  return { dialogRef, handleClose };
}
