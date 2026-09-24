import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./lib/ui";
import { useThemePack } from "./lib/theme";
import { Landing } from "./pages/Landing";

// Every route but the front door is its own chunk. They were one 497 KB bundle,
// so the page a returning account opens every morning paid for the poker
// table, the standup, the plugin admin and the Meet add-on before it could
// draw a list of links.
const OrgDirectory = lazy(() => import("./pages/OrgDirectory").then((m) => ({ default: m.OrgDirectory })));
const SpacePage = lazy(() => import("./pages/SpacePage").then((m) => ({ default: m.SpacePage })));
const SpaceSettingsPage = lazy(() =>
  import("./pages/SpaceSettingsPage").then((m) => ({ default: m.SpaceSettingsPage })),
);
const SessionPage = lazy(() => import("./pages/SessionPage").then((m) => ({ default: m.SessionPage })));
const PresentPage = lazy(() => import("./pages/PresentPage").then((m) => ({ default: m.PresentPage })));
const LinkPage = lazy(() => import("./pages/LinkPage").then((m) => ({ default: m.LinkPage })));
const PluginsPage = lazy(() => import("./pages/PluginsPage").then((m) => ({ default: m.PluginsPage })));
const MeetSidePanel = lazy(() => import("./pages/MeetAddon").then((m) => ({ default: m.MeetSidePanel })));
const MeetMainStage = lazy(() => import("./pages/MeetAddon").then((m) => ({ default: m.MeetMainStage })));

const queryClient = new QueryClient();

export default function App() {
  // Applied above every route, so an installed theme pack reaches the landing
  // page too — and above the router, so it survives navigation.
  useThemePack();
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          {/* No fallback art: a chunk on the same origin lands in a frame or
              two, and a spinner flashed for that long reads as a stutter. */}
          <Suspense fallback={null}>
            <Routes>
              <Route path="/" element={<Landing />} />
              {/* The org directory: how somebody finds their team's room
                  without being sent a link. It lists what the server says this
                  caller may see — org-visible spaces plus their own — and being
                  listed is discovery, not entry: a space with a passcode still
                  asks for it. */}
              <Route path="/o/:org" element={<OrgDirectory />} />
              {/* A space slug is unique inside an org, not across the
                  instance, so both halves are in the path — see lib/paths. */}
              {/* The operator's plugin surface. It is under the org because
                  that is where the operator role lives; the server 403s an
                  ordinary member reaching the API behind it. */}
              <Route path="/o/:org/admin/plugins" element={<PluginsPage />} />
              <Route path="/o/:org/s/:slug" element={<SpacePage />} />
              <Route path="/o/:org/s/:slug/settings" element={<SpaceSettingsPage />} />
              <Route path="/session/:id" element={<SessionPage />} />
              <Route path="/session/:id/present" element={<PresentPage />} />
              {/* Both of these stay un-prefixed, deliberately. A session id is
                  a globally-unique uuid and this is the URL people paste into
                  chat mid-standup; /link is the landing page for a signed link,
                  reached by someone who has no identity yet and therefore no org
                  — prefixing it would make every issued link unopenable.
                  The token rides in the fragment, so /link takes no parameter of
                  its own — see lib/links. */}
              <Route path="/link" element={<LinkPage />} />
              {/* The Google Meet add-on's two framed documents. The server
                  serves them from their own route group; they sign in with a
                  bearer token, never the cookie. */}
              <Route path="/embed/meet/sidepanel" element={<MeetSidePanel />} />
              <Route path="/embed/meet/mainstage" element={<MeetMainStage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
