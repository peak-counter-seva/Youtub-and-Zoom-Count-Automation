import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

/** If something on a page breaks, show the error and a way back instead of a blank white page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 480, margin: "15vh auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong on this page</h2>
        <p style={{ color: "#555", lineHeight: 1.5 }}>Counting and SMS are not affected. Send a screenshot of this to get it fixed.</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "#eee", padding: 12, borderRadius: 8, marginTop: 12 }}>{this.state.error.message}</pre>
        <button style={{ marginTop: 12, padding: "10px 16px" }} onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
