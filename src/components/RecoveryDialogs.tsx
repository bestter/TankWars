import { useEffect, useId, useRef, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { VGA_PALETTE } from "../types/game";
import { useModalDialog } from "./modalDialog";

export function ProtocolMismatchDialog() {
  const { t } = useTranslation();
  const titleId = useId();
  const { dialogRef, handleClose } = useModalDialog({ dismissActiveModals: true });
  const refreshBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    refreshBtnRef.current?.focus();
  }, []);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault();
  };

  return (
    <dialog
      ref={dialogRef}
      className="retro-modal protocol-mismatch-overlay"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
    >
      <h2 id={titleId} style={{ margin: 0, fontSize: "16px" }}>
        {t("protocol_mismatch_title")}
      </h2>
      <p role="alert">{t("protocol_mismatch_body")}</p>
      <button
        ref={refreshBtnRef}
        type="button"
        onClick={() => window.location.reload()}
      >
        {t("protocol_mismatch_refresh")}
      </button>
    </dialog>
  );
}

export interface SessionErrorDialogProps {
  readonly roundPreparationError?: "EXHAUSTED" | "NEW_GAME_REQUIRED" | null;
  readonly networkError?: string | null;
  readonly onRetry: () => void;
  readonly onReturnToMenu?: () => void;
}

export function SessionErrorDialog({
  roundPreparationError,
  networkError,
  onRetry,
  onReturnToMenu,
}: SessionErrorDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const { dialogRef, handleClose } = useModalDialog({ dismissActiveModals: true });
  const retryBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);

  const canRetry =
    roundPreparationError === "EXHAUSTED" ||
    (!roundPreparationError && Boolean(networkError));

  useEffect(() => {
    if (canRetry) {
      retryBtnRef.current?.focus();
    } else {
      menuBtnRef.current?.focus();
    }
  }, [canRetry]);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault();
  };

  let message = "";
  if (roundPreparationError) {
    message = t(
      roundPreparationError === "NEW_GAME_REQUIRED"
        ? "round_new_game_required"
        : "round_preparation_failed",
    );
  } else if (networkError) {
    message = t(networkError, { defaultValue: networkError });
  }

  return (
    <dialog
      ref={dialogRef}
      className="retro-modal retro-modal-error"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
      style={{
        border: `4px solid ${VGA_PALETTE.RED}`,
      }}
    >
      <h2
        id={titleId}
        role="alert"
        style={{
          margin: 0,
          fontSize: "14px",
          fontWeight: "normal",
          color: VGA_PALETTE.RED,
          lineHeight: 1.4,
        }}
      >
        {message}
      </h2>
      <div className="retro-modal-error-actions">
        {canRetry && (
          <button
            ref={retryBtnRef}
            type="button"
            onClick={onRetry}
            className="retro-btn"
            style={{ padding: "8px 24px" }}
          >
            {t("btn_retry")}
          </button>
        )}
        {onReturnToMenu && (
          <button
            ref={menuBtnRef}
            type="button"
            onClick={onReturnToMenu}
            className="round-summary-menu-btn"
          >
            {t("btn_menu")}
          </button>
        )}
      </div>
    </dialog>
  );
}

export interface OnlineQuitConfirmDialogProps {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function OnlineQuitConfirmDialog({
  onCancel,
  onConfirm,
}: OnlineQuitConfirmDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const { dialogRef, closeDialog, handleClose } = useModalDialog({
    onDismiss: onCancel,
  });
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);

  const handleCancelClick = () => {
    closeDialog("cancel");
    onCancel();
  };

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement, Event>) => {
    event.preventDefault();
    handleCancelClick();
  };

  const handleConfirmClick = () => {
    closeDialog("confirm");
    onConfirm();
  };

  return (
    <dialog
      ref={dialogRef}
      className="retro-modal retro-modal-confirm"
      aria-labelledby={titleId}
      onCancel={handleCancel}
      onClose={handleClose}
    >
      <h2 id={titleId} className="retro-modal-confirm-title">
        {t("online_quit_confirm")}
      </h2>
      <div className="retro-modal-confirm-actions">
        <button
          ref={cancelBtnRef}
          type="button"
          className="retro-btn"
          onClick={handleCancelClick}
        >
          {t("online_quit_cancel")}
        </button>
        <button
          type="button"
          className="round-summary-menu-btn"
          onClick={handleConfirmClick}
        >
          {t("online_quit_confirm_btn")}
        </button>
      </div>
    </dialog>
  );
}
