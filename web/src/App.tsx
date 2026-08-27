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
            {/* A space slug is unique inside an org, not across the
                instance, so both halves are in the path — see lib/paths. */}
            <Route path="/o/:org/s/:slug" element={<SpacePage />} />
            <Route path="/o/:org/s/:slug/settings" element={<SpaceSettingsPage />} />
            <Route path="/session/:id" element={<SessionPage />} />
            {/* Both of these stay un-prefixed, deliberately. A session id is
                a globally-unique uuid and this is the URL people paste into
                chat mid-standup; /link is the landing page for a signed link,
                reached by someone who has no identity yet and therefore no org
                — prefixing it would make every issued link unopenable.
                The token rides in the fragment, so /link takes no parameter of
                its own — see lib/links. */}
            <Route path="/link" element={<LinkPage />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
