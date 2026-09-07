// JSDOM does not implement showModal/close. Simulate lifecycle events only;
// real Chrome proof owns focus, inertness, Escape and invoker restoration.
export function installDialogLifecycle(window) {
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
}
