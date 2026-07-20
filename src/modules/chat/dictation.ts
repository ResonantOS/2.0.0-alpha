// Intent citation: docs/architecture/ADR-001-platform-stack.md

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

export const resolveSpeechRecognitionCtor = (): (new () => BrowserSpeechRecognition) | null => {
  const scope = window as typeof window & {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
};

export const canUseDictation = (): boolean =>
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  Boolean(resolveSpeechRecognitionCtor());

export const requestMicrophoneAccess = async (): Promise<void> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Audio dictate is not available in this browser context.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
};
