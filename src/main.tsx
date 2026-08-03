import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./matte.css";
import "./agent-activity.css";
import "./main-agent-activity.css";
import "./sessions.css";
import "./rail.css";
import "./settings.css";
import "./project-trust.css";
import "./todos.css";
/* Readability is the final typography floor; it must win the cascade. */
import "./readability.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
