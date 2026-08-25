import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./lib/ui";
import { Landing } from "./pages/Landing";
import { SpacePage } from "./pages/SpacePage";
import { SpaceSettingsPage } from "./pages/SpaceSettingsPage";
import { SessionPage } from "./pages/SessionPage";
import { LinkPage } from "./pages/LinkPage";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/s/:slug" element={<SpacePage />} />
            <Route path="/s/:slug/settings" element={<SpaceSettingsPage />} />
            <Route path="/session/:id" element={<SessionPage />} />
            {/* The token rides in the fragment, so this route takes no
                parameter of its own — see lib/links. */}
            <Route path="/link" element={<LinkPage />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
