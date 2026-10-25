import RFB from "./novnc/core/rfb.js";
import { openerMessage, READY_MESSAGE, screenParams, socketUrl } from "./params.js";

const OPENER_WAIT_MS = 15_000;

const fromFragment = screenParams(window.location.hash);
window.history.replaceState(null, "", window.location.pathname);

const surface = document.getElementById("surface");
const status = document.getElementById("status");
const message = document.getElementById("message");

function show(state, text) {
  status.dataset.state = state;
  message.textContent = text;
}

function forgetBoardStorage() {
  try {
    window.sessionStorage.clear();
  } catch (error) {
    console.warn("couldn't clear the copied session storage", error);
  }
}

function connect(params) {
  show("connecting", "Connecting to the virtual computer…");
  let refused = false;
  const rfb = new RFB(surface, socketUrl(params), { credentials: { password: params.password }, shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  rfb.addEventListener("connect", () => show("connected", "Connected"));
  rfb.addEventListener("credentialsrequired", () => {
    refused = true;
    rfb.disconnect();
  });
  rfb.addEventListener("securityfailure", () => {
    refused = true;
  });
  rfb.addEventListener("disconnect", () => {
    if (refused) return show("error", "The screen didn't accept this link. Open the screen again from Hive.");
    show("closed", "Disconnected. Open the screen again from Hive.");
  });
}

function waitForOpener() {
  const opener = window.opener;
  const giveUp = window.setTimeout(() => finish({ kind: "invalid" }), OPENER_WAIT_MS);
  function finish(result) {
    window.clearTimeout(giveUp);
    window.removeEventListener("message", onMessage);
    window.opener = null;
    if (result.kind === "secrets") connect(result.params);
    else show("error", "This screen link isn't valid. Open the screen again from Hive.");
  }
  function onMessage(event) {
    const result = openerMessage(event, window.location.origin, opener);
    if (result.kind !== "ignore") finish(result);
  }
  window.addEventListener("message", onMessage);
  opener.postMessage({ type: READY_MESSAGE }, window.location.origin);
}

forgetBoardStorage();
if (fromFragment) {
  window.opener = null;
  connect(fromFragment);
} else if (window.opener) {
  waitForOpener();
} else {
  show("error", "This screen link isn't valid. Open the screen again from Hive.");
}
