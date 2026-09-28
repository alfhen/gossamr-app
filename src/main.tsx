import { isTauri } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { MockBackend } from "./backend/mock";
import "./index.css";
import { useStore } from "./store";

if (isTauri()) document.documentElement.classList.add("tauri");

void useStore.getState().init(new MockBackend());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
