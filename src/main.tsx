import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { I18nProvider } from "./lib/i18n.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
