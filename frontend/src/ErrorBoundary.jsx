import React from "react";

// Catches render-time errors anywhere below and shows the message + stack
// instead of a blank page, so problems are diagnosable in production.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    // eslint-disable-next-line no-console
    console.error("UI crashed:", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div style={{ padding: 24, fontFamily: "ui-monospace,Menlo,monospace", color: "#e6ecf3", background: "#1a2030", minHeight: "100vh" }}>
        <h2 style={{ color: "#f43f5e", marginTop: 0 }}>⚠ Something went wrong</h2>
        <p>An error occurred while rendering. Please copy this and report it:</p>
        <pre style={{ whiteSpace: "pre-wrap", background: "#0f1320", padding: 12, borderRadius: 8, border: "1px solid #333", fontSize: 12.5 }}>
{String(error && (error.stack || error.message || error))}
{info && info.componentStack ? "\n\nComponent stack:" + info.componentStack : ""}
        </pre>
        <button onClick={() => location.reload()}
          style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #555", background: "#232831", color: "#fff", cursor: "pointer" }}>
          Reload
        </button>
      </div>
    );
  }
}
