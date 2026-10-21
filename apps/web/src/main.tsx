import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";

import { Follow } from "./app/Follow";
import { Shell } from "./app/Shell";
import { queries } from "./data/api";
import { FrameProvider } from "./data/frame";
import { FarmPage } from "./farm/FarmPage";
import { ChatPage } from "./pages/chat/ChatPage";
import { AgentsRoute } from "./pages/agents/AgentsPage";
import { DocsPage } from "./pages/docs/DocsPage";
import { CatalogPage } from "./pages/catalog/CatalogPage";
import { IssuesPage } from "./pages/issues/IssuesPage";
import { ProjectsPage } from "./pages/projects/ProjectsPage";
import { RuntimesPage } from "./pages/runtimes/RuntimesPage";
import { ManagerPage } from "./pages/manager/ManagerPage";
import { PairPage } from "./pages/pair/PairPage";
import { isPaired, isRemote } from "./rules/lan";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { ToastProvider } from "./ui/Toast";
import "./style.css";

// A device not paired yet pairs before anything else: without a key the farm's listener answers nothing.
if (isRemote(location.hostname) && !isPaired(document.cookie) && location.pathname !== "/pair") location.replace("/pair");

// The farm is full-bleed, outside the workbench's shell; the shell links back to it.
const router = createBrowserRouter([
  { index: true, element: <FarmPage /> },
  { path: "pair", element: <PairPage /> },
  {
    element: <Shell />,
    children: [
      { path: "issues/*", element: <IssuesPage /> },
      { path: "chat/*", element: <ChatPage /> },
      { path: "settings/*", element: <SettingsPage /> },
      { path: "manager/*", element: <ManagerPage /> },
      { path: "agents/*", element: <AgentsRoute /> },
      { path: "runtimes/*", element: <RuntimesPage /> },
      { path: "projects/*", element: <ProjectsPage /> },
      { path: "docs/*", element: <DocsPage /> },
      { path: "catalog/*", element: <CatalogPage /> },
    ],
  },
  // Nowhere the page knows: the farm.
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <FrameProvider>
        <ToastProvider>
          <Follow />
          <RouterProvider router={router} />
        </ToastProvider>
      </FrameProvider>
    </QueryClientProvider>
  </StrictMode>,
);
