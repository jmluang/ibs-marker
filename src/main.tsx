import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { bootstrapCloud, type CloudController } from "./cloud/bootstrap";
import { CloudPanel, useCloud } from "./cloud/CloudPanel";
import "./styles.css";

const manifest = document.createElement("link");
manifest.rel = "manifest";
manifest.href = "/manifest.webmanifest";
document.head.append(manifest);
const theme = document.createElement("meta");
theme.name = "theme-color";
theme.content = "#f7f5f0";
document.head.append(theme);

// Cloud configuration owns identity selection. Never activate local implicitly here.
let cloud: CloudController | null = null;
try {
  cloud = await bootstrapCloud();
} catch {
  // Store failures remain observable in App; do not discard data or fake a cloud login.
}
function ConnectedApp({ controller }: { controller: CloudController }) {
  const state = useCloud(controller);
  return <App privateMode={state.privateMode} authenticated={state.mode === "cloud"}
    onEnterLocal={controller.enterLocal.bind(controller)} cloudPanel={<CloudPanel controller={controller} />} />;
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    {cloud ? <ConnectedApp controller={cloud} /> : <App privateMode={true}
      cloudPanel={
        cloud ? (
          <CloudPanel controller={cloud} />
        ) : (
          <section className="notice" role="alert">
            <h2>暂时无法初始化记录存储</h2>
            <p>请关闭可能阻塞的其他标签页后重试。已有记录不会被自动清除。</p>
            <button onClick={() => location.reload()}>重新打开</button>
          </section>
        )
      }
    />}
  </React.StrictMode>,
);
import.meta.hot?.dispose(() => {
  cloud?.dispose();
  root.unmount();
});

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const register = () => {
    void navigator.serviceWorker
      .register(
        "/sw.js?build=" +
          encodeURIComponent(import.meta.env.VITE_BUILD_ID ?? "shell"),
      )
      .catch(() => {
        /* Online use remains available; offline readiness is verified separately. */
      });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
