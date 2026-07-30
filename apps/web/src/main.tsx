import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { registerPwa } from "./register-pwa.js";
import "./index.css";

registerPwa();

const root = document.getElementById("root");
if (!root) throw new Error("OMP Remote could not find its application root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
