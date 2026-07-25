// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-004-chat-rail.md

import type { MutableRefObject } from "react";

import type { DictationController } from "../../dictation";
import type { ComposerAttachment } from "./types";
import { isTextLikeFile } from "./utils";

type SetState<T> = (value: T | ((current: T) => T)) => void;

export const attachComposerFiles = async (
  files: FileList | null,
  setAttachments: SetState<ComposerAttachment[]>,
  fileInputRef: MutableRefObject<HTMLInputElement | null>,
): Promise<void> => {
  if (!files?.length) {
    return;
  }

  const nextAttachments = await Promise.all(
    Array.from(files).map(async (file, index) => {
      let content: string | undefined;
      let previewState: ComposerAttachment["previewState"] = "metadata-only";
      if (isTextLikeFile(file) && file.size <= 64 * 1024) {
        previewState = "embedded";
        content = (await file.text()).slice(0, 12000);
      }
      return {
        id: `${file.name}-${file.size}-${Date.now()}-${index}`,
        name: file.name,
        size: file.size,
        type: file.type,
        content,
        previewState,
      } satisfies ComposerAttachment;
    }),
  );

  setAttachments((current) => [...current, ...nextAttachments]);
  if (fileInputRef.current) {
    fileInputRef.current.value = "";
  }
};

export const removeComposerAttachment = (
  attachmentId: string,
  setAttachments: SetState<ComposerAttachment[]>,
): void => {
  setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
};

type ToggleDictationInput = {
  controller: DictationController | null;
  setChatNotice: SetState<string | null>;
};

export const toggleComposerDictation = ({
  controller,
  setChatNotice,
}: ToggleDictationInput): void => {
  if (!controller) {
    setChatNotice("Audio dictate is not available in this browser context.");
    return;
  }

  void controller.toggle().catch((error: unknown) => {
    setChatNotice(
      error instanceof Error
        ? `Audio dictate failed: ${error.message}`
        : "Audio dictate failed.",
    );
  });
};
