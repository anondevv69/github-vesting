import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams } from "react-router-dom";
import "./styles/vesting.css";
import { ExplorePage } from "./pages/ExplorePage";
import { LockPage } from "./pages/LockPage";
import { DevProfilePage } from "./pages/DevProfilePage";
import { CreatePage } from "./pages/CreatePage";
import { HelpPage } from "./pages/HelpPage";
import { AgentsPage } from "./pages/AgentsPage";
import { LinkGithubPage } from "./pages/LinkGithubPage";
import { lockPathFromRepo, isValidRepoFullName } from "./lib/repoId";

function LegacyDevRedirect() {
  const { username = "" } = useParams();
  return <Navigate to={`/dev/${username}`} replace />;
}

function LegacyStatusRedirect() {
  const [params] = useSearchParams();
  const repo = params.get("repo");
  if (repo && isValidRepoFullName(repo)) {
    return <Navigate to={lockPathFromRepo(repo)} replace />;
  }
  return <Navigate to="/" replace />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ExplorePage />} />
        <Route path="/lock/:owner/:repoName" element={<LockPage />} />
        <Route path="/dev/:username" element={<DevProfilePage />} />
        <Route path="/create" element={<CreatePage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/link-github" element={<LinkGithubPage />} />
        <Route path="/agents" element={<AgentsPage />} />

        <Route path="/vesting/explore" element={<Navigate to="/" replace />} />
        <Route path="/vesting/setup" element={<Navigate to="/create" replace />} />
        <Route path="/vesting/dashboard" element={<Navigate to="/" replace />} />
        <Route path="/vesting/dev/:username" element={<LegacyDevRedirect />} />
        <Route path="/vesting/token/:token" element={<Navigate to="/" replace />} />
        <Route path="/vesting/status" element={<LegacyStatusRedirect />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
