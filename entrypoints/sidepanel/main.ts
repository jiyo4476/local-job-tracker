import { browser } from 'wxt/browser';

const captureFrame =
  document.querySelector<HTMLIFrameElement>('#capture-frame');
let activeTabId: number | undefined;

function reloadCaptureFrame(): void {
  if (captureFrame) captureFrame.contentWindow?.location.reload();
}

void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  activeTabId = tab?.id;
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  reloadCaptureFrame();
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'complete') {
    reloadCaptureFrame();
  }
});
