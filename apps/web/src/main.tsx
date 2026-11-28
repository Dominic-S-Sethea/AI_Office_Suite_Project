import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/kantumruy-pro/400.css";
import "@fontsource/kantumruy-pro/500.css";
import "@fontsource/kantumruy-pro/600.css";
import "@fontsource/kantumruy-pro/700.css";
import "@fontsource/noto-sans-khmer/400.css";
import "@fontsource/noto-sans-khmer/500.css";
import "@fontsource/noto-sans-khmer/600.css";
import "@fontsource/noto-sans-khmer/700.css";
import "./styles.css";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scopeLabel="AI Office Suite">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
