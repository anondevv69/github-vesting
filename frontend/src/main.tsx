import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { VestingSetupPage } from "./pages/VestingSetupPage";
import { VestingStatusPage } from "./pages/VestingStatusPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/vesting/setup" element={<VestingSetupPage />} />
        <Route path="/vesting/status" element={<VestingStatusPage />} />
        <Route path="/" element={<Navigate to="/vesting/setup" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
