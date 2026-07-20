// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// Intent citation: docs/architecture/ADR-004-chat-rail.md

import type { MutableRefObject } from "react";

import { canUseDictation, requestMicrophoneAccess, resolveSpeechRecognitionCtor } from "./dictation";
import type { ComposerAttachment } from "./types";
import { isTextLikeFile } from "./utils";

export type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

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
  dictating: boolean;
  speechRecognitionRef: MutableRefObject<BrowserSpeechRecognition | null>;
  setDictating: SetState<boolean>;
  setComposer: SetState<string>;
  setChatNotice: SetState<string | null>;
  errorMessageOf: (error: unknown, fallback: string) => string;
};

export const toggleComposerDictation = ({
  dictating,
  speechRecognitionRef,
  setDictating,
  setComposer,
  setChatNotice,
  errorMessageOf,
}: ToggleDictationInput): void => {
  if (!canUseDictation()) {
    setChatNotice("Audio dictate is not available in this browser context.");
    return;
  }

  if (dictating) {
    speechRecognitionRef.current?.stop();
    setDictating(false);
    return;
  }

  void (async () => {
    const Recognition = resolveSpeechRecognitionCtor() as (new () => BrowserSpeechRecognition) | null;
    if (!Recognition) {
      setChatNotice("Audio dictate is not available in this browser context.");
      return;
    }
    try {
      await requestMicrophoneAccess();
    } catch (error) {
      setChatNotice(errorMessageOf(error, "Audio dictate failed: microphone permission was not granted."));
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) {
        setComposer((current) => `${current}${current ? " " : ""}${transcript}`.trim());
      }
    };
    recognition.onerror = (event) => {
      setChatNotice(`Audio dictate failed: ${event.error}`);
      setDictating(false);
    };
    recognition.onend = () => {
      setDictating(false);
    };
    speechRecognitionRef.current = recognition;
    setChatNotice(null);
    setDictating(true);
    recognition.start();
  })();
};
