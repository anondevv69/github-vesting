import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./styles/vesting.css";
import { VestingSetupPage } from "./pages/VestingSetupPage";
import { VestingStatusPage } from "./pages/VestingStatusPage";
import { VestingDashboardPage } from "./pages/VestingDashboardPage";
import { VestingExplorePage } from "./pages/VestingExplorePage";
import { VestingTokenPage } from "./pages/VestingTokenPage";
import { VestingDevPage } from "./pages/VestingDevPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/vesting/dashboard" element={<VestingDashboardPage />} />
        <Route path="/vesting/setup" element={<VestingSetupPage />} />
        <Route path="/vesting/status" element={<VestingStatusPage />} />
        <Route path="/vesting/explore" element={<VestingExplorePage />} />
        <Route path="/vesting/token/:token" element={<VestingTokenPage />} />
        <Route path="/vesting/dev/:login" element={<VestingDevPage />} />
        <Route path="/" element={<Navigate to="/vesting/explore" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
